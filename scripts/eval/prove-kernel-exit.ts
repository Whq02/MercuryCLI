#!/usr/bin/env bun
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { check as baseCheck, cleanup, finish, loadEval, refusingBridge, section, setup, sleep, within } from './lib.js'
import type { ProcKernel } from '../../src/tools/engines/eval-kernels/procKernel.js'

const check = (label: string, cond: boolean, detail = '', fix = ''): void => baseCheck(label, cond, cond || !fix ? detail : detail ? `${detail} — ${fix}` : fix)

const { work } = setup()
const { pythonCandidates } = await import('../../src/tools/engines/eval-kernels/interpreters.js')
const { EVAL_SHUTDOWN_GRACE_MS } = await import('../../src/tools/engines/eval-kernels/contracts.js')

const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
const REPORT_WINDOW_MS = 3_000
const KEGS = ['3.14', '3.13', '3.12', '3.11', '3.10', '3'].map(v => join('/opt/homebrew/opt', `python@${v}`, 'bin', `python${v}`))

function newestPython(): { path: string; version: string } | { whyNot: string } {
  const seen = new Set<string>()
  const refused: string[] = []
  let best: { path: string; version: string; major: number; minor: number } | null = null
  for (const candidate of [...pythonCandidates(work), ...KEGS]) {
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
  console.log(`  [SKIP] kernel-exit: ${python.whyNot} — the Eval tool refuses anything under 3.10, so no kernel can start here and nothing is proved`)
  cleanup()
  process.exit(0)
}
process.env.MERCURY_EVAL_PYTHON = python.path
console.log(`  kernels run under ${python.path} (${python.version}); crash reports counted under ${REPORTS}`)

const { EvalKernelManager } = await loadEval()
const bridge = refusingBridge()

function pythonReports(): string[] {
  try {
    return readdirSync(REPORTS).filter(name => /^Python-.*\.ips$/.test(name)).sort()
  } catch {
    return []
  }
}

function reportPid(name: string): number | null {
  try {
    const match = /"pid"\s*:\s*(\d+)/.exec(readFileSync(join(REPORTS, name), 'utf8'))
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function reportsAfter(before: string[], pid: number): Promise<{ after: string[]; fresh: string[]; ours: string[] }> {
  const deadline = Date.now() + REPORT_WINDOW_MS
  for (;;) {
    const after = pythonReports()
    const fresh = after.filter(name => !before.includes(name))
    const ours = fresh.filter(name => reportPid(name) === pid)
    if (ours.length > 0 || Date.now() >= deadline) return { after, fresh, ours }
    await sleep(200)
  }
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

type Exit = { code: number | null; signal: string | null; at: number }
type Seam = { kernels: Map<string, { kernel: ProcKernel }> }
type Manager = InstanceType<typeof EvalKernelManager>
type Live = { manager: Manager; kernel: ProcKernel; child: ChildProcess; pid: number; exit: Promise<Exit>; before: string[] }

const managers: Manager[] = []
function freshManager(): Manager {
  const manager = new EvalKernelManager()
  managers.push(manager)
  return manager
}

function attach(manager: Manager, before: string[]): Live | null {
  const entries = [...(manager as unknown as Seam).kernels.values()]
  const kernel = entries[0]?.kernel
  if (entries.length !== 1 || !kernel || !kernel.alive || kernel.pid === undefined) return null
  const child = (kernel as unknown as { child: ChildProcess }).child
  const exit = new Promise<Exit>(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })))
  return { manager, kernel, child, pid: kernel.pid, exit, before }
}

async function settle(name: string, live: Live, since: number, settledAt: number): Promise<void> {
  const exit = await within(`${name}: the kernel exit`, EVAL_SHUTDOWN_GRACE_MS * 2 + 2_000, live.exit).catch(() => null)
  check(`${name}: the kernel exited`, exit !== null, '', 'the kernel did not leave within the grace; see ProcKernel.dispose in src/tools/engines/eval-kernels/procKernel.ts and the SIGTERM handler in src/tools/engines/eval-kernels/pyRunnerSource.ts')
  check(`${name}: exit code 0`, exit?.code === 0, `code=${String(exit?.code)} signal=${String(exit?.signal)}`, 'the Python runner must leave through its one exit path with code 0; see the exit and SIGTERM handling in src/tools/engines/eval-kernels/pyRunnerSource.ts')
  check(`${name}: exit signal null (never SIGABRT, never SIGTERM)`, exit !== null && exit.signal === null, `signal=${String(exit?.signal)}`, 'the runner must exit itself instead of being killed or aborting; see the exit and SIGTERM handling in src/tools/engines/eval-kernels/pyRunnerSource.ts and ProcKernel.dispose in src/tools/engines/eval-kernels/procKernel.ts')
  check(`${name}: left within the polite grace, before any escalation`, exit !== null && exit.at - since < EVAL_SHUTDOWN_GRACE_MS, exit ? `${exit.at - since} ms` : 'no exit', 'the kernel must leave before EVAL_SHUTDOWN_GRACE_MS (src/tools/engines/eval-kernels/contracts.ts) runs out; see ProcKernel.dispose in src/tools/engines/eval-kernels/procKernel.ts')
  check(`${name}: the cell's done frame and end marks came before the exit`, exit !== null && settledAt <= exit.at, '', 'the kernel exited before the cell settled; see ProcKernel.exec in src/tools/engines/eval-kernels/procKernel.ts')
  const reports = await reportsAfter(live.before, live.pid)
  console.log(`      Python crash reports: ${live.before.length} before, ${reports.after.length} after${reports.fresh.length > 0 ? ` (new: ${reports.fresh.join(', ')})` : ''}`)
  check(`${name}: no new Python crash report for the kernel (pid ${live.pid})`, reports.ours.length === 0, reports.ours.join(', '), 'the Python runner crashed at exit; the report names the file under DiagnosticReports, and src/tools/engines/eval-kernels/pyRunnerSource.ts must leave through os._exit instead of finalization')
  await live.manager.disposeAll()
  check(`${name}: the manager holds no kernel`, live.manager.kernelCount() === 0, String(live.manager.kernelCount()), 'disposeAll in src/tools/engines/eval-kernels/kernelManager.ts must drop every kernel')
  check(`${name}: the kernel process is gone`, gone(live.pid), '', 'the kernel process outlived disposeAll; see ProcKernel.dispose in src/tools/engines/eval-kernels/procKernel.ts')
}

async function oneCell(name: string, end: (live: Live) => Promise<void>): Promise<void> {
  section(name)
  const manager = freshManager()
  const before = pythonReports()
  const outcome = await within(`${name}: the cell`, 60_000, manager.runCell({
    owner: 'owner-exit',
    cwd: work,
    input: { language: 'py', code: 'x = 1; print(x)' },
    abortSignal: new AbortController().signal,
    serveBridge: bridge,
  }))
  const settledAt = Date.now()
  check(`${name}: the cell ran clean and its stdout arrived`, outcome.status === 'ok' && outcome.stdout.text === '1\n', JSON.stringify({ error: outcome.error, notes: outcome.annotations, stderr: outcome.stderr.text }), 'a plain Python cell failed on a fresh kernel; see runCell in src/tools/engines/eval-kernels/kernelManager.ts')
  check(`${name}: both end marks settled the cell, not the grace`, outcome.runtimeMs < 1_200, `${outcome.runtimeMs} ms`, 'the cell must settle on the end marks; see the mark handling and END_MARK_GRACE_MS in src/tools/engines/eval-kernels/procKernel.ts')
  const live = attach(manager, before)
  check(`${name}: the manager retains one live kernel`, live !== null, String(manager.kernelCount()), 'the manager must keep exactly one live kernel after a cell; see EvalKernelManager in src/tools/engines/eval-kernels/kernelManager.ts')
  if (!live) {
    await manager.disposeAll()
    return
  }
  const since = Date.now()
  await end(live)
  await settle(name, live, since, settledAt)
}

async function midCell(name: string): Promise<void> {
  section(name)
  const manager = freshManager()
  const before = pythonReports()
  const controller = new AbortController()
  let printed: () => void = () => undefined
  const beforeLine = new Promise<void>(resolve => {
    printed = resolve
  })
  let liveStdout = ''
  const run = manager.runCell({
    owner: 'owner-exit',
    cwd: work,
    input: { language: 'py', code: 'import time\nprint("before", flush=True)\ntime.sleep(30)\nprint("after")' },
    abortSignal: controller.signal,
    serveBridge: bridge,
    onLiveOutput: (stream, chunk) => {
      if (stream !== 'stdout') return
      liveStdout += chunk
      if (liveStdout.includes('before\n')) printed()
    },
  })
  await within(`${name}: the cell's first line, newline included (the unbuffered runner writes the word and its newline separately)`, 60_000, beforeLine)
  const live = attach(manager, before)
  check(`${name}: the manager retains one live kernel mid-cell`, live !== null, String(manager.kernelCount()), 'the manager must keep exactly one live kernel while a cell runs; see EvalKernelManager in src/tools/engines/eval-kernels/kernelManager.ts')
  if (!live) {
    controller.abort()
    await run.catch(() => undefined)
    await manager.disposeAll()
    return
  }
  live.child.once('exit', () => controller.abort())
  const since = Date.now()
  process.kill(live.pid, 'SIGTERM')
  const exit = await within(`${name}: the kernel exit`, EVAL_SHUTDOWN_GRACE_MS * 2 + 2_000, live.exit).catch(() => null)
  const outcome = await within(`${name}: the cell outcome`, 10_000, run)
  check(`${name}: the kernel left at once with exit code 0`, exit !== null && exit.code === 0 && exit.signal === null && exit.at - since < EVAL_SHUTDOWN_GRACE_MS, exit ? `code=${String(exit.code)} signal=${String(exit.signal)} after ${exit.at - since} ms` : 'no exit', 'on SIGTERM the Python runner must flush and exit 0 at once; see the SIGTERM handler in src/tools/engines/eval-kernels/pyRunnerSource.ts')
  check(`${name}: the bytes the cell had printed reached the host`, outcome.stdout.text === 'before\n', JSON.stringify(outcome.stdout.text), 'bytes printed before the kernel left must reach the host; see the stdout handling in ProcKernel in src/tools/engines/eval-kernels/procKernel.ts')
  check(`${name}: the cell reports the kernel's death and is not retried`, outcome.status === 'error' && outcome.annotations.some(note => note.includes('not retried')), JSON.stringify(outcome.annotations), 'a kernel that left on SIGTERM while its cell ran must be reported as dead and not retried; see the dead-kernel handling in runCell in src/tools/engines/eval-kernels/kernelManager.ts')
  const reports = await reportsAfter(before, live.pid)
  console.log(`      Python crash reports: ${before.length} before, ${reports.after.length} after${reports.fresh.length > 0 ? ` (new: ${reports.fresh.join(', ')})` : ''}`)
  check(`${name}: no new Python crash report for the kernel (pid ${live.pid})`, reports.ours.length === 0, reports.ours.join(', '))
  await manager.disposeAll()
  check(`${name}: the manager holds no kernel`, manager.kernelCount() === 0, String(manager.kernelCount()), 'disposeAll in src/tools/engines/eval-kernels/kernelManager.ts must drop every kernel')
  check(`${name}: the kernel process is gone`, gone(live.pid), '', 'the kernel process outlived disposeAll; see ProcKernel.dispose in src/tools/engines/eval-kernels/procKernel.ts')
}

try {
  await oneCell('§1 dispose(): the polite bye on the command stream', async live => {
    await live.manager.disposeAll()
  })
  await oneCell('§2 EOF on the command stream (the host closes stdin)', async live => {
    live.child.stdin?.end()
  })
  await oneCell('§3 SIGTERM to the kernel while it idles', async live => {
    process.kill(live.pid, 'SIGTERM')
  })
  await midCell('§4 SIGTERM mid-cell: the kernel leaves at once, flushed')
} finally {
  await Promise.all(managers.map(manager => manager.disposeAll().catch(() => undefined)))
  cleanup()
}
finish('KERNEL-EXIT')
