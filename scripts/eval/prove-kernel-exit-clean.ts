#!/usr/bin/env bun
import { spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, refusingBridge, section, setup, sleep, within } from './lib.js'
import type { ProcKernel } from '../../src/services/eval/procKernel.js'

const { work } = setup()
const { pythonCandidates } = await import('../../src/services/eval/interpreters.js')
const { EVAL_SHUTDOWN_GRACE_MS } = await import('../../src/services/eval/contracts.js')

const ROUNDS = Math.max(1, Number(process.env.KERNEL_EXIT_CLEAN_ROUNDS ?? 20) || 20)
const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')

function newestPython(): { path: string; version: string } | { whyNot: string } {
  const seen = new Set<string>()
  const refused: string[] = []
  let best: { path: string; version: string; major: number; minor: number } | null = null
  const kegs = ['3.15', '3.14', '3.13', '3.12', '3.11', '3.10', '3'].map(v => join('/opt/homebrew/opt', `python@${v}`, 'bin', `python${v}`))
  for (const candidate of [...pythonCandidates(work), ...kegs]) {
    if (seen.has(candidate) || (candidate.includes('/') && !existsSync(candidate))) continue
    seen.add(candidate)
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    const match = /Python\s+(\d+)\.(\d+)\S*/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
    if (!match) {
      refused.push(`${candidate} (no version)`)
      continue
    }
    const [major, minor] = [Number(match[1]), Number(match[2])]
    if (major < 3 || (major === 3 && minor < 10)) {
      refused.push(`${candidate} (${match[0]})`)
      continue
    }
    if (!best || major > best.major || (major === best.major && minor > best.minor)) best = { path: candidate, version: match[0], major, minor }
  }
  if (best) return { path: best.path, version: best.version }
  return { whyNot: refused.length > 0 ? `no Python 3.10+ on this box; refused ${refused.join(', ')}` : 'no python3 binary on this box' }
}

const python = newestPython()
if ('whyNot' in python) {
  console.log(`  [SKIP] kernel-exit-clean: ${python.whyNot} — the Eval tool refuses anything under 3.10, so no kernel can start here and nothing is proved`)
  cleanup()
  process.exit(0)
}
process.env.MERCURY_EVAL_PYTHON = python.path
console.log(`  kernels run under ${python.path} (${python.version}); ${ROUNDS} starts and ends per road; crash reports read under ${REPORTS}`)

const { EvalKernelManager } = await loadEval()
const bridge = refusingBridge()

type Exit = { code: number | null; signal: string | null; at: number }
type Seam = { kernels: Map<string, { kernel: ProcKernel }> }
type Manager = InstanceType<typeof EvalKernelManager>

function pythonReports(): string[] {
  try {
    return readdirSync(REPORTS).filter(name => /^Python-.*\.ips$/.test(name)).sort()
  } catch {
    return []
  }
}

function reportPids(names: string[]): Set<number> {
  const pids = new Set<number>()
  for (const name of names) {
    try {
      const match = /"pid"\s*:\s*(\d+)/.exec(readFileSync(join(REPORTS, name), 'utf8'))
      if (match) pids.add(Number(match[1]))
    } catch {
      continue
    }
  }
  return pids
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

let bunStdioFlakes = 0
type CellRequest = Parameters<Manager['runCell']>[0]
async function runCell(manager: Manager, request: CellRequest): Promise<Awaited<ReturnType<Manager['runCell']>>> {
  for (let attempt = 1; ; attempt++) {
    try {
      const outcome = await manager.runCell(request)
      if (attempt < 4 && outcome.status === 'error' && outcome.error?.name === 'EvalUnavailable' && /failed to spawn|handshake failed/.test(outcome.error.value)) {
        bunStdioFlakes++
        await sleep(100)
        continue
      }
      return outcome
    } catch (error) {
      if (attempt < 4 && /Failed to connect/.test(String(error))) {
        bunStdioFlakes++
        await sleep(100)
        continue
      }
      throw error
    }
  }
}

function liveKernel(manager: Manager): { kernel: ProcKernel; child: ChildProcess; pid: number; exit: Promise<Exit> } | null {
  const entries = [...(manager as unknown as Seam).kernels.values()]
  const kernel = entries[0]?.kernel
  if (entries.length !== 1 || !kernel || !kernel.alive || kernel.pid === undefined) return null
  const child = (kernel as unknown as { child: ChildProcess }).child
  const exit = new Promise<Exit>(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })))
  return { kernel, child, pid: kernel.pid, exit }
}

function watchSpawns(manager: Manager): { exits: Exit[]; pids: number[]; stop: () => void } {
  const exits: Exit[] = []
  const pids: number[] = []
  const kernels = (manager as unknown as Seam).kernels
  const set = kernels.set
  const observe = (entry: { kernel: ProcKernel }): void => {
    const child = (entry.kernel as unknown as { child: ChildProcess }).child
    if (child.pid && !pids.includes(child.pid)) {
      pids.push(child.pid)
      if (child.exitCode !== null || child.signalCode !== null) exits.push({ code: child.exitCode, signal: child.signalCode, at: Date.now() })
      else child.once('exit', (code, signal) => exits.push({ code, signal, at: Date.now() }))
    }
  }
  kernels.set = function (key, entry) {
    observe(entry)
    return set.call(this, key, entry)
  }
  for (const entry of kernels.values()) observe(entry)
  return { exits, pids, stop: () => { kernels.set = set } }
}

async function runMarker(manager: Manager, owner: string, n: number): Promise<{ ok: boolean; detail: string }> {
  const marker = `last-line-${n}`
  const outcome = await within(`${owner} ${n}: the cell`, 60_000, runCell(manager, {
    owner,
    cwd: work,
    input: { language: 'py', code: `print("${marker}")` },
    abortSignal: new AbortController().signal,
    serveBridge: bridge,
  }))
  return { ok: outcome.status === 'ok' && outcome.stdout.text === `${marker}\n`, detail: JSON.stringify({ status: outcome.status, stdout: outcome.stdout.text, notes: outcome.annotations }) }
}

const observerMap: Seam['kernels'] = new Map()
const observer = watchSpawns({ kernels: observerMap } as unknown as Manager)
const observerChild = Object.assign(new EventEmitter(), { pid: 1_000_000, exitCode: null, signalCode: null })
observerMap.set('briefly-live', { kernel: { child: observerChild } as unknown as ProcKernel })
observerChild.emit('exit', 1, null)
observerMap.delete('briefly-live')
observer.stop()
check('§0: a kernel registered and exited in one turn is still observed', observer.pids.length === 1 && observer.exits.length === 1 && observer.exits[0]?.code === 1, JSON.stringify(observer.exits))

const allPids: number[] = []
const reportsBefore = pythonReports()

type RoadResult = { exits: Exit[]; markers: number; aborts: number; wrong: string[] }

async function road(name: string, end: (manager: Manager, live: NonNullable<ReturnType<typeof liveKernel>>, n: number) => Promise<{ expectCode: number | null; expectSignal: string | null; within: number }>): Promise<void> {
  section(name)
  const result: RoadResult = { exits: [], markers: 0, aborts: 0, wrong: [] }
  for (let n = 1; n <= ROUNDS; n++) {
    const manager = new EvalKernelManager()
    const marker = await runMarker(manager, `${name}-${n}`, n)
    if (marker.ok) result.markers++
    else result.wrong.push(`round ${n}: ${marker.detail}`)
    const live = liveKernel(manager)
    if (!live) {
      result.wrong.push(`round ${n}: no live kernel after the cell`)
      await manager.disposeAll()
      continue
    }
    allPids.push(live.pid)
    const since = Date.now()
    const expect = await end(manager, live, n)
    const exit = await within(`${name} ${n}: the kernel exit`, expect.within + 5_000, live.exit).catch(() => null)
    if (exit === null) {
      result.wrong.push(`round ${n}: no exit`)
      live.kernel.killNow()
    } else {
      result.exits.push(exit)
      if (exit.signal === 'SIGABRT') result.aborts++
      if (exit.code !== expect.expectCode || exit.signal !== expect.expectSignal) result.wrong.push(`round ${n}: code=${String(exit.code)} signal=${String(exit.signal)} after ${exit.at - since} ms`)
      else if (exit.at - since > expect.within) result.wrong.push(`round ${n}: left after ${exit.at - since} ms, over ${expect.within}`)
    }
    await manager.disposeAll()
    if (!gone(live.pid)) {
      await sleep(200)
      if (!gone(live.pid)) result.wrong.push(`round ${n}: pid ${live.pid} still alive`)
    }
  }
  check(`${name}: ${ROUNDS} kernels started and the marker line arrived whole every time`, result.markers === ROUNDS, result.wrong.slice(0, 3).join(' | '))
  check(`${name}: ${ROUNDS} kernels ended and none by SIGABRT`, result.exits.length === ROUNDS && result.aborts === 0, `exits=${result.exits.length} aborts=${result.aborts}`)
  check(`${name}: every exit had the road's own code and signal, within its window`, result.wrong.length === 0, result.wrong.slice(0, 3).join(' | '))
}

try {
  await road('§1 explicit shutdown (dispose: the bye frame)', async manager => {
    void manager.disposeAll()
    return { expectCode: 0, expectSignal: null, within: EVAL_SHUTDOWN_GRACE_MS }
  })

  section('§2 idle reap (the sweep disposes an idle kernel)')
  {
    const result: RoadResult = { exits: [], markers: 0, aborts: 0, wrong: [] }
    for (let n = 1; n <= ROUNDS; n++) {
      const manager = new EvalKernelManager({ idleTtlMs: 150, idleSweepMs: 25 })
      const marker = await runMarker(manager, `reap-${n}`, n)
      if (marker.ok) result.markers++
      else result.wrong.push(`round ${n}: ${marker.detail}`)
      const live = liveKernel(manager)
      if (!live) {
        result.wrong.push(`round ${n}: no live kernel after the cell`)
        continue
      }
      allPids.push(live.pid)
      const since = Date.now()
      const exit = await within(`reap ${n}: the kernel exit`, 150 + EVAL_SHUTDOWN_GRACE_MS + 5_000, live.exit).catch(() => null)
      if (exit === null) {
        result.wrong.push(`round ${n}: no exit`)
        live.kernel.killNow()
      } else {
        result.exits.push(exit)
        if (exit.signal === 'SIGABRT') result.aborts++
        if (exit.code !== 0 || exit.signal !== null) result.wrong.push(`round ${n}: code=${String(exit.code)} signal=${String(exit.signal)} after ${exit.at - since} ms`)
      }
      await manager.disposeAll()
    }
    check(`§2: ${ROUNDS} kernels started and the marker line arrived whole every time`, result.markers === ROUNDS, result.wrong.slice(0, 3).join(' | '))
    check(`§2: ${ROUNDS} kernels reaped and none by SIGABRT`, result.exits.length === ROUNDS && result.aborts === 0, `exits=${result.exits.length} aborts=${result.aborts}`)
    check('§2: every reaped kernel left with exit 0 and no signal', result.wrong.length === 0, result.wrong.slice(0, 3).join(' | '))
  }

  await road('§3 SIGTERM to an idle kernel', async (_manager, live) => {
    process.kill(live.pid, 'SIGTERM')
    return { expectCode: 0, expectSignal: null, within: EVAL_SHUTDOWN_GRACE_MS }
  })

  await road('§4 the manager\'s kill (SIGTERM first; a responsive kernel leaves before the strike)', async (_manager, live) => {
    live.kernel.kill()
    return { expectCode: 0, expectSignal: null, within: EVAL_SHUTDOWN_GRACE_MS }
  })

  section('§5 SIGTERM mid-cell: the bytes already printed reach the host whole, the kernel leaves at once')
  {
    let aborts = 0
    let clean = 0
    let intact = 0
    const wrong: string[] = []
    for (let n = 1; n <= ROUNDS; n++) {
      const manager = new EvalKernelManager()
      const controller = new AbortController()
      let printed: () => void = () => undefined
      const beforeLine = new Promise<void>(resolve => {
        printed = resolve
      })
      let liveStdout = ''
      const run = runCell(manager, {
        owner: `mid-${n}`,
        cwd: work,
        input: { language: 'py', code: `import time\nprint("before-${n}", flush=True)\ntime.sleep(30)\nprint("after")` },
        abortSignal: controller.signal,
        serveBridge: bridge,
        onLiveOutput: (stream, chunk) => {
          if (stream !== 'stdout') return
          liveStdout += chunk
          if (liveStdout.includes(`before-${n}\n`)) printed()
        },
      })
      await within(`mid ${n}: the first line`, 60_000, Promise.race([beforeLine, run.then(() => undefined)]))
      const live = liveKernel(manager)
      if (!live) {
        wrong.push(`round ${n}: no live kernel mid-cell`)
        controller.abort()
        await run.catch(() => undefined)
        await manager.disposeAll()
        continue
      }
      allPids.push(live.pid)
      live.child.once('exit', () => controller.abort())
      const since = Date.now()
      process.kill(live.pid, 'SIGTERM')
      const exit = await within(`mid ${n}: the kernel exit`, EVAL_SHUTDOWN_GRACE_MS * 2 + 2_000, live.exit).catch(() => null)
      const outcome = await within(`mid ${n}: the cell outcome`, 10_000, run)
      if (exit?.signal === 'SIGABRT') aborts++
      if (exit !== null && exit.code === 0 && exit.signal === null && exit.at - since < EVAL_SHUTDOWN_GRACE_MS) clean++
      else wrong.push(`round ${n}: ${exit ? `code=${String(exit.code)} signal=${String(exit.signal)} after ${exit.at - since} ms` : 'no exit'}`)
      if (outcome.stdout.text === `before-${n}\n`) intact++
      else wrong.push(`round ${n}: stdout ${JSON.stringify(outcome.stdout.text)}`)
      await manager.disposeAll()
    }
    check(`§5: ${ROUNDS} kernels left at once with exit 0 on SIGTERM mid-cell, none by SIGABRT`, clean === ROUNDS && aborts === 0, `clean=${clean} aborts=${aborts} ${wrong.slice(0, 3).join(' | ')}`)
    check(`§5: the printed line reached the host whole every time`, intact === ROUNDS, wrong.slice(0, 3).join(' | '))
  }

  section('§6 the escalation: a kernel that ignores SIGTERM is struck with SIGKILL after the grace, never left to abort')
  {
    const manager = new EvalKernelManager()
    const outcome = await within('§6: the cell', 60_000, runCell(manager, {
      owner: 'ignores-term',
      cwd: work,
      input: { language: 'py', code: 'import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("deaf")' },
      abortSignal: new AbortController().signal,
      serveBridge: bridge,
    }))
    check('§6: the cell ran', outcome.status === 'ok' && outcome.stdout.text === 'deaf\n', JSON.stringify(outcome.stdout.text))
    const live = liveKernel(manager)
    check('§6: the kernel is alive after the cell', live !== null)
    if (live) {
      allPids.push(live.pid)
      const since = Date.now()
      live.kernel.kill()
      const exit = await within('§6: the kernel exit', 5_000, live.exit).catch(() => null)
      check('§6: the strike landed as SIGKILL after the grace, not SIGABRT and not never', exit !== null && exit.signal === 'SIGKILL' && exit.at - since >= 400 && exit.at - since < 3_000, exit ? `signal=${String(exit.signal)} after ${exit.at - since} ms` : 'no exit')
    }
    await manager.disposeAll()
  }

  section('§7 the road that aborted: a cell whose error cannot be printed (stderr broken, a __str__ that raises)')
  {
    const cell = [
      'import sys',
      'class Bad:',
      '    def write(self, s):',
      '        raise OSError(5, "stderr is gone")',
      '    def flush(self):',
      '        pass',
      'sys.stderr = Bad()',
      'class E(Exception):',
      '    def __str__(self):',
      '        raise TypeError("no str")',
      'raise E()',
    ].join('\n')
    let aborts = 0
    let survived = 0
    let reported = 0
    const wrong: string[] = []
    for (let n = 1; n <= ROUNDS; n++) {
      const manager = new EvalKernelManager()
      const watch = watchSpawns(manager)
      const outcome = await within(`§7 ${n}: the cell`, 60_000, runCell(manager, {
        owner: `broken-${n}`,
        cwd: work,
        input: { language: 'py', code: cell },
        abortSignal: new AbortController().signal,
        serveBridge: bridge,
      }))
      await sleep(50)
      watch.stop()
      allPids.push(...watch.pids)
      aborts += watch.exits.filter(e => e.signal === 'SIGABRT').length
      const live = liveKernel(manager)
      if (live !== null) survived++
      if (outcome.status === 'error' && outcome.error?.name === 'E' && !outcome.annotations.some(a => /died/.test(a))) reported++
      else wrong.push(`round ${n}: ${JSON.stringify({ status: outcome.status, error: outcome.error?.name, notes: outcome.annotations, exits: watch.exits })}`)
      await manager.disposeAll()
    }
    check(`§7: ${ROUNDS} rounds, no kernel aborted`, aborts === 0, `aborts=${aborts}`)
    check(`§7: the cell reports its error and the kernel survives every time (no death, no retry)`, reported === ROUNDS && survived === ROUNDS, `reported=${reported} survived=${survived} ${wrong.slice(0, 2).join(' | ')}`)
  }

  section('§8 the roads that still end the kernel from inside a cell leave through the one exit, never finalization')
  {
    const cases: Array<[string, string, number | null, string | null]> = [
      ['the protocol pipe closed by the cell', 'import os\nos.close(3)\nprint("hi")', 1, null],
      ['the protocol pipe closed and stderr broken', 'import os, sys\nclass Bad:\n    def write(self, s):\n        raise OSError(5, "gone")\n    def flush(self):\n        pass\nsys.stderr = Bad()\nos.close(3)\nprint("hi")', 1, null],
    ]
    for (const [label, code, expectCode, expectSignal] of cases) {
      let aborts = 0
      let asExpected = 0
      const wrong: string[] = []
      for (let n = 1; n <= 5; n++) {
        const manager = new EvalKernelManager()
        const watch = watchSpawns(manager)
        await within(`§8 ${label} ${n}`, 60_000, runCell(manager, { owner: `pipe-${n}`, cwd: work, input: { language: 'py', code }, abortSignal: new AbortController().signal, serveBridge: bridge }))
        await sleep(50)
        watch.stop()
        allPids.push(...watch.pids)
        aborts += watch.exits.filter(e => e.signal === 'SIGABRT').length
        if (watch.exits.length > 0 && watch.exits.every(e => e.code === expectCode && e.signal === expectSignal)) asExpected++
        else wrong.push(`round ${n}: ${JSON.stringify(watch.exits)}`)
        await manager.disposeAll()
      }
      check(`§8 ${label}: no SIGABRT in 5 rounds`, aborts === 0, `aborts=${aborts}`)
      check(`§8 ${label}: every kernel left with exit ${String(expectCode)} and no signal`, asExpected === 5, wrong.slice(0, 2).join(' | '))
    }
  }

  section('§9 the reader holds no lock: a cell may close sys.__stdin__ and the kernel goes on')
  {
    const manager = new EvalKernelManager()
    const outcome = await within('§9: the cell', 60_000, runCell(manager, {
      owner: 'stdin-close',
      cwd: work,
      input: { language: 'py', code: 'import sys\nsys.__stdin__.close()\nprint("still here")' },
      abortSignal: new AbortController().signal,
      serveBridge: bridge,
    }))
    check('§9: the cell completes and the kernel is not wedged on the stdin buffer lock', outcome.status === 'ok' && outcome.stdout.text === 'still here\n', JSON.stringify({ status: outcome.status, notes: outcome.annotations }))
    const again = await within('§9: the next cell', 60_000, runCell(manager, {
      owner: 'stdin-close',
      cwd: work,
      input: { language: 'py', code: 'print("next")' },
      abortSignal: new AbortController().signal,
      serveBridge: bridge,
    }))
    check('§9: the same kernel runs the next cell', again.status === 'ok' && again.stdout.text === 'next\n' && !again.annotations.some(a => /replaced|reaped|died/.test(a)), JSON.stringify(again.annotations))
    const live = liveKernel(manager)
    if (live) allPids.push(live.pid)
    await manager.disposeAll()
  }

  section('§10 crash reports')
  {
    await sleep(1_500)
    const fresh = pythonReports().filter(name => !reportsBefore.includes(name))
    const ours = [...reportPids(fresh)].filter(pid => allPids.includes(pid))
    console.log(`      ${allPids.length} kernel pids this run (${bunStdioFlakes} spawn retried on Bun's stdio connect flake); ${reportsBefore.length} Python crash reports before, ${fresh.length} new${fresh.length > 0 ? ` (${fresh.join(', ')})` : ''}`)
    check('§10: no Python crash report names a kernel of this run', ours.length === 0, ours.join(', '))
  }
} finally {
  cleanup()
}

finish('KERNEL-EXIT-CLEAN')
