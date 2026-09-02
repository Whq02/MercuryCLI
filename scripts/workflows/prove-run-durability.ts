#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-run-durability.ts
//  PROOF: workflow durability + restart recovery (Sol 5.6 WS3).
//
//  Before this pass: workflow.js persistence and the initial/terminal
//  run.json writes were fire-and-forget (a failed initial write could launch
//  a run that a crash left unrecoverable; a fast exit could strand run.json
//  claiming 'running' after the completion notification); /workflows offered
//  R resume only for in-memory Recent rows.
//
//   (1) PURE MATRIX — diskResumability: completed → rerun-as-new; running
//       under a LIVE owner → refused; orphaned/paused/failed/killed with
//       recoverable source+args → ok; digest mismatch / missing source /
//       oversized-args-preview / corrupt args.json → refused with the exact
//       reason.
//   (2) ATOMIC LAUNCH — a real WorkflowTool.call() in a fresh child: when
//       call() returns, workflow.js + args.json + run.json are ON DISK
//       (awaited, not racing), the digest matches, and at completion
//       run.json is terminal the moment the task settles.
//   (3) LAUNCH FAILURE — the runs root sabotaged (a FILE where the dir
//       belongs): call() throws the precise 'workflow not launched' error,
//       no task row leaks, no half-run remains.
//   (4) CRASH → ORPHAN → DISK RESUME — child launches a hanging fixture,
//       SIGKILLed mid-run; the manifest (heartbeat backdated past the stale
//       window, owner dead) classifies PAST+orphaned; diskResumability
//       recovers script+args; a REAL WorkflowTool.call({scriptPath,
//       resumeFromRunId}) relaunches it from disk artifacts alone.
//   (5) JOURNAL REUSE ACROSS PROCESS DEATH — the executor with REAL
//       makeWorkflowHooks and a FAKE spawnSubagentStream (no model calls):
//       process D settles agent 'first' into journal.jsonl and dies
//       (SIGKILL) mid-'second'; process E re-runs the same script+runId —
//       'first' returns from the JOURNAL CACHE (its spawn is never called),
//       only 'second' spawns, the final result stitches cached+live.
//
//  Run:  ~/.bun/bin/bun run scripts/workflows/prove-run-durability.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (cond()) return true
    if (Date.now() > deadline) return false
    await wait(60)
  }
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex')
const scratch = mkdtempSync(join(tmpdir(), 'wf-durability-'))

console.log('============================================================')
console.log(' Workflow durability — atomic launch · awaited finals · disk resume')
console.log('============================================================')

// ---------------------------------------------------------------------------
section('(1) diskResumability — the pure eligibility matrix')
{
  const { diskResumability } = await import('../../src/tools/WorkflowTool/runManifest.js')
  const dir = join(scratch, 'matrix-run')
  mkdirSync(dir, { recursive: true })
  const script = "export const meta = { name: 'm', description: 'd' }\nreturn 1"
  writeFileSync(join(dir, 'workflow.js'), script)
  writeFileSync(join(dir, 'args.json'), JSON.stringify({ q: 'exact' }))
  const deps = {
    pidAlive: (pid: number) => pid === process.pid,
    fileExists: existsSync,
    readFileText: (p: string) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    sha256,
  }
  const base = { runDir: dir, ownerPid: 424242, scriptDigest: sha256(script) }

  const completed = diskResumability({ ...base, status: 'completed' as const }, deps)
  check('completed → refused, points at S save/rerun', !completed.ok && /S saves/.test((completed as { reason: string }).reason))

  const liveOwner = diskResumability({ ...base, status: 'running' as const, ownerPid: process.pid }, deps)
  check('running under a LIVE owner → refused', !liveOwner.ok && /live pid/.test((liveOwner as { reason: string }).reason))

  const orphaned = diskResumability({ ...base, status: 'running' as const }, deps)
  check('orphaned (running, dead owner) → ok, args from args.json', orphaned.ok && JSON.stringify((orphaned as { args: unknown }).args) === '{"q":"exact"}')

  for (const status of ['paused', 'failed', 'killed'] as const) {
    const r = diskResumability({ ...base, status }, deps)
    check(`${status} → ok (script + exact args recovered)`, r.ok)
  }

  const mismatch = diskResumability({ ...base, status: 'failed' as const, scriptDigest: sha256('DIFFERENT') }, deps)
  check('digest mismatch → refused with the reason', !mismatch.ok && /digest mismatch/.test((mismatch as { reason: string }).reason))

  const noSource = diskResumability({ runDir: join(scratch, 'nowhere'), ownerPid: 1, status: 'failed' as const }, deps)
  check('missing source → refused with the paths', !noSource.ok && /source missing/.test((noSource as { reason: string }).reason))

  const bigArgs = diskResumability(
    { runDir: join(scratch, 'bigargs'), ownerPid: 1, status: 'failed' as const, argsPreview: 'x'.repeat(100), scriptPath: join(dir, 'workflow.js') },
    deps,
  )
  check('argsPreview-only (pre-args.json) → refused honestly', !bigArgs.ok && /args too large/.test((bigArgs as { reason: string }).reason))

  const corruptDir = join(scratch, 'corrupt-args')
  mkdirSync(corruptDir, { recursive: true })
  writeFileSync(join(corruptDir, 'workflow.js'), script)
  writeFileSync(join(corruptDir, 'args.json'), '{ not json')
  const corrupt = diskResumability({ runDir: corruptDir, ownerPid: 1, status: 'failed' as const }, deps)
  check('corrupt args.json → refused', !corrupt.ok && /corrupt/.test((corrupt as { reason: string }).reason))

  const embedded = diskResumability({ ...base, runDir: join(scratch, 'embedded'), scriptPath: join(dir, 'workflow.js'), status: 'killed' as const, args: { a: 1 }, scriptDigest: sha256(script) }, deps)
  check('no args.json + small embedded args → ok via manifest.args', embedded.ok && JSON.stringify((embedded as { args: unknown }).args) === '{"a":1}')
}

// ---------------------------------------------------------------------------
// Shared child harness: drives the REAL WorkflowTool.call in a fresh process
// (getGlobalConfig/getCwd are per-process; §DEPS-TDZ needs the tasks.js
// pre-import). Emits JSON lines the parent asserts on.
// ---------------------------------------------------------------------------
const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-dur-home-'))
await import('${REPO}/src/tasks.js')
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))
const state: any = { tasks: {} }
const ctx: any = {
  getAppState: () => state,
  setAppState: (fn: any) => { const next = typeof fn === 'function' ? fn(state) : fn; for (const k of Object.keys(next)) (state as any)[k] = (next as any)[k] },
  options: { mainLoopModel: 'claude-opus-4-8' },
  abortController: new AbortController(),
  toolUseId: 'dur-tool-use',
}
const mode = process.env.DUR_MODE
const script = mode === 'hang'
  ? "export const meta = { name: 'hang-fixture', description: 'hangs forever' }\nphase?.('One')\nlog('hanging now')\nawait new Promise(() => {})\nreturn 'unreachable'"
  : "export const meta = { name: 'quick-fixture', description: 'completes fast', phases: [{ title: 'One' }] }\nphase('One')\nlog('quick')\nreturn 'fixture-done'"
try {
  const input: any = mode === 'resume'
    ? { scriptPath: process.env.DUR_SCRIPT_PATH, resumeFromRunId: process.env.DUR_RESUME_RUN }
    : { script, args: { fixture: true, n: 7 } }
  const res = await WorkflowTool.call(input, ctx, async () => ({ behavior: 'allow' }))
  const d = res.data
  const runDir = d.transcriptDir
  emit({
    ev: 'launched', runId: d.runId, runDir, scriptPath: d.scriptPath,
    wfOnDisk: existsSync(join(runDir, 'workflow.js')),
    argsOnDisk: existsSync(join(runDir, 'args.json')),
    manifestOnDisk: existsSync(join(runDir, 'run.json')),
    manifest: existsSync(join(runDir, 'run.json')) ? JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) : null,
  })
  if (mode === 'hang' || mode === 'resume') {
    // stay alive; the parent kills us
    setInterval(() => {}, 1000)
  } else {
    for (let i = 0; i < 300; i++) {
      const t: any = Object.values(state.tasks)[0]
      if (t && t.status !== 'running' && t.status !== 'pending') {
        emit({ ev: 'settled', task: t.status, manifest: JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).status })
        process.exit(0)
      }
      await new Promise(r => setTimeout(r, 100))
    }
    emit({ ev: 'timeout' })
    process.exit(1)
  }
} catch (e) {
  emit({ ev: 'threw', name: (e as Error).name, message: (e as Error).message, tasks: Object.keys(state.tasks).length })
  process.exit(0)
}
`

interface ChildEvents {
  lines: Array<Record<string, unknown>>
  status: number | null
}
function runChild(cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<ChildEvents> {
  return new Promise(resolve => {
    const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
      cwd,
      env: { ...process.env, ...env },
    })
    const lines: Array<Record<string, unknown>> = []
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      for (const line of buf.split('\n')) {
        if (line.startsWith('@@')) {
          try {
            const parsed = JSON.parse(line.slice(2))
            if (!lines.some(l => JSON.stringify(l) === JSON.stringify(parsed))) lines.push(parsed)
          } catch {
            /* partial line */
          }
        }
      }
    })
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', status => {
      clearTimeout(killer)
      resolve({ lines, status })
    })
  })
}
writeFileSync(join(scratch, 'child.ts'), CHILD)

// ---------------------------------------------------------------------------
section('(2) atomic launch + terminal ordering (real WorkflowTool.call)')
{
  const cwd = join(scratch, 'atomic-cwd')
  mkdirSync(cwd, { recursive: true })
  const r = await runChild(cwd, {})
  const launched = r.lines.find(l => l.ev === 'launched') as Record<string, unknown> | undefined
  const settled = r.lines.find(l => l.ev === 'settled') as Record<string, unknown> | undefined
  check('child launched + settled', !!launched && !!settled, JSON.stringify(r.lines).slice(0, 300))
  if (launched) {
    check('workflow.js ON DISK when call() returns (awaited)', launched.wfOnDisk === true)
    check('args.json ON DISK when call() returns', launched.argsOnDisk === true)
    check('run.json ON DISK when call() returns', launched.manifestOnDisk === true)
    const m = launched.manifest as { scriptDigest?: string; status?: string; args?: unknown } | null
    check('initial manifest says running', m?.status === 'running')
    const wf = readFileSync(join(String(launched.runDir), 'workflow.js'), 'utf8')
    check('manifest scriptDigest matches the persisted script', m?.scriptDigest === sha256(wf))
    const argsJson = readFileSync(join(String(launched.runDir), 'args.json'), 'utf8')
    check('args.json carries the exact args', argsJson === JSON.stringify({ fixture: true, n: 7 }))
  }
  if (settled) {
    check('task settled completed', settled.task === 'completed')
    check('run.json is TERMINAL the moment the task settles (awaited final)', settled.manifest === 'completed')
  }
}

// ---------------------------------------------------------------------------
section('(3) launch-persistence failure → precise error, no half-run')
{
  const cwd = join(scratch, 'sabotage-cwd')
  mkdirSync(join(cwd, '.mercury', 'workflows'), { recursive: true })
  // the runs ROOT is a FILE — mkdir of the run dir must fail
  writeFileSync(join(cwd, '.mercury', 'workflows', 'runs'), 'not a directory')
  const r = await runChild(cwd, {})
  const threw = r.lines.find(l => l.ev === 'threw') as Record<string, unknown> | undefined
  check('call() threw instead of launching', !!threw, JSON.stringify(r.lines).slice(0, 300))
  if (threw) {
    check('error is the precise workflow-not-launched contract', /workflow not launched/.test(String(threw.message)) && /Nothing was started/.test(String(threw.message)))
    check('no task row leaks', threw.tasks === 0)
  }
}

// ---------------------------------------------------------------------------
section('(4) crash → orphan classification → REAL disk resume')
{
  const cwd = join(scratch, 'crash-cwd')
  mkdirSync(cwd, { recursive: true })
  // Launch the hanging fixture and SIGKILL it once the run dir is durable.
  const childP = spawn(BUN, ['run', join(scratch, 'child.ts')], {
    cwd,
    env: { ...process.env, DUR_MODE: 'hang' },
  })
  let out = ''
  childP.stdout.on('data', (d: Buffer) => (out += d.toString()))
  const sawLaunch = await until(() => out.includes('"ev":"launched"'), 45_000)
  check('hanging run launched (durable artifacts on disk)', sawLaunch, out.slice(0, 200))
  const launched = sawLaunch
    ? (JSON.parse(out.split('\n').find(l => l.startsWith('@@'))!.slice(2)) as Record<string, unknown>)
    : undefined
  childP.kill('SIGKILL')
  await wait(300)

  if (launched) {
    const runDir = String(launched.runDir)
    // Backdate the heartbeat past the stale window (the real orphan signal is
    // heartbeat silence + a dead pid — we compress the 45s wait).
    const old = (Date.now() - 120_000) / 1000
    utimesSync(join(runDir, 'run.json'), old, old)

    const { listWorkflowRuns, partitionDiskRuns, runLiveness } = await import('../../src/tools/WorkflowTool/runManifest.js')
    const { diskResumability } = await import('../../src/tools/WorkflowTool/runManifest.js')
    const runs = await listWorkflowRuns(cwd)
    const m = runs.find(x => x.runId === launched.runId)
    check('crashed run listed from disk', !!m)
    if (m) {
      const pidAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      check('manifest still claims running (the crash left it mid-flight)', m.status === 'running')
      check('liveness reads ORPHANED (stale heartbeat + dead owner)', runLiveness(m, m.mtimeMs, Date.now(), pidAlive) === 'orphaned')
      const { external, past } = partitionDiskRuns([m], new Set(), Date.now(), pidAlive)
      check('partition files it under PAST (never external)', past.length === 1 && external.length === 0)
      const res = diskResumability(m, {
        pidAlive,
        fileExists: existsSync,
        readFileText: (p: string) => {
          try {
            return readFileSync(p, 'utf8')
          } catch {
            return undefined
          }
        },
        sha256,
      })
      check('diskResumability recovers script + args', res.ok, res.ok ? '' : (res as { reason: string }).reason)

      if (res.ok) {
        // The REAL resume path: a fresh process, WorkflowTool.call with ONLY
        // disk-recovered inputs. The fixture hangs again by design — the
        // assertion is that the resume LAUNCHES from disk artifacts alone and
        // re-owns the manifest.
        const resumeP = spawn(BUN, ['run', join(scratch, 'child.ts')], {
          cwd,
          env: {
            ...process.env,
            DUR_MODE: 'resume',
            DUR_SCRIPT_PATH: res.scriptPath,
            DUR_RESUME_RUN: String(launched.runId),
          },
        })
        let resumeOut = ''
        resumeP.stdout.on('data', (d: Buffer) => (resumeOut += d.toString()))
        const resumed = await until(() => resumeOut.includes('"ev":"launched"'), 45_000)
        check('disk resume relaunches through the real tool path', resumed, resumeOut.slice(0, 200))
        if (resumed) {
          const line = JSON.parse(resumeOut.split('\n').find(l => l.startsWith('@@'))!.slice(2)) as Record<string, unknown>
          check('resume keeps the SAME runId (longest-prefix cache semantics)', line.runId === launched.runId)
          const m2 = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { ownerPid: number; status: string }
          check('manifest re-owned by the resuming process (fresh pid, running)', m2.status === 'running' && m2.ownerPid !== m.ownerPid)
        }
        resumeP.kill('SIGKILL')
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('(5) journal reuse across process death (real hooks, fake spawn)')
{
  const runDir = join(scratch, 'journal-run')
  mkdirSync(runDir, { recursive: true })
  const flag = join(runDir, 'let-second-finish.flag')
  const spawnLogD = join(runDir, 'spawns-D.log')
  const spawnLogE = join(runDir, 'spawns-E.log')

  const EXEC_CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-exec-home-'))
await import('${REPO}/src/tasks.js')
const { compileWorkflow, parseWorkflowScript } = await import('${REPO}/src/tools/WorkflowTool/compiler.js')
const { runWorkflowScript } = await import('${REPO}/src/tools/WorkflowTool/executor.js')
const { makeWorkflowHooks, LocalFileJournal } = await import('${REPO}/src/tools/WorkflowTool/agentHooks.js')
const runDir = process.env.EXEC_RUN_DIR!
const flag = process.env.EXEC_FLAG!
const spawnLog = process.env.EXEC_SPAWN_LOG!
const script = "export const meta = { name: 'journal-fixture', description: 'two agents' }\nconst a = await agent('first probe question')\nlog('first settled')\nconst b = await agent('second probe question')\nreturn String(a) + '|' + String(b)"
const parsed = parseWorkflowScript(script)
const compiled = compileWorkflow((parsed as any).scriptBody)
if (!(compiled as any).ok) { console.log('@@' + JSON.stringify({ ev: 'compile-failed' })); process.exit(1) }
async function* fakeSpawn(a: any) {
  const which = a.prompt.includes('first') ? 'first' : 'second'
  appendFileSync(spawnLog, which + '\n')
  if (which === 'second') {
    while (!existsSync(flag)) await new Promise(r => setTimeout(r, 50))
  }
  yield {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: which === 'first' ? 'ALPHA' : 'BETA' }],
      usage: { output_tokens: 3 },
      stop_reason: 'end_turn',
    },
  }
}
const state: any = {
  tasks: {},
  toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
  mcp: { tools: [] },
}
const ctx: any = {
  getAppState: () => state,
  setAppState: () => {},
  options: { mainLoopModel: 'claude-opus-4-8' },
  abortController: new AbortController(),
  canUseTool: async () => ({ behavior: 'allow' }),
}
const result = await runWorkflowScript((compiled as any).vmScript, ctx, () => {}, {
  makeHooks: (args: any) => makeWorkflowHooks({ ...args, spawnSubagentStream: fakeSpawn }),
  workflowRunId: 'wf_journal_fixture',
  journal: new LocalFileJournal(runDir),
  getCwd: () => runDir,
})
console.log('@@' + JSON.stringify({ ev: 'done', error: result.error ?? null, result: result.result }))
process.exit(0)
`
  writeFileSync(join(scratch, 'exec-child.ts'), EXEC_CHILD)
  const env = { EXEC_RUN_DIR: runDir, EXEC_FLAG: flag, EXEC_SPAWN_LOG: spawnLogD }

  // Process D: agent1 settles into the journal; killed while agent2 waits.
  const d = spawn(BUN, ['run', join(scratch, 'exec-child.ts')], { cwd: REPO, env: { ...process.env, ...env } })
  let dOut = ''
  d.stdout.on('data', (b: Buffer) => (dOut += b.toString()))
  d.stderr.on('data', () => {})
  const journalPath = join(runDir, 'journal.jsonl')
  const firstSettled = await until(() => {
    try {
      return readFileSync(journalPath, 'utf8').includes('"type":"result"')
    } catch {
      return false
    }
  }, 60_000)
  check("process D settled agent 'first' into journal.jsonl", firstSettled, dOut.slice(0, 200))
  const secondStartedInD = await until(() => {
    try {
      return readFileSync(spawnLogD, 'utf8').includes('second')
    } catch {
      return false
    }
  }, 30_000)
  check("process D reached agent 'second' (blocked on the flag)", secondStartedInD)
  d.kill('SIGKILL')
  await wait(300)
  check('process D is dead mid-run (SIGKILL — no terminal write possible)', d.killed)

  // Process E: same runId + journal; the flag lets 'second' finish instantly.
  writeFileSync(flag, 'go')
  const e = spawnSync(BUN, ['run', join(scratch, 'exec-child.ts')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env, EXEC_SPAWN_LOG: spawnLogE },
  })
  const doneLine = (e.stdout ?? '').split('\n').find(l => l.startsWith('@@'))
  const done = doneLine ? (JSON.parse(doneLine.slice(2)) as { error: string | null; result: unknown }) : undefined
  check('process E completed the run', !!done && done.error === null, (e.stderr ?? '').slice(0, 300))
  check('final result stitches CACHED first + LIVE second (ALPHA|BETA)', done?.result === 'ALPHA|BETA', String(done?.result))
  const spawnsE = existsSync(spawnLogE) ? readFileSync(spawnLogE, 'utf8').trim().split('\n') : []
  check("E spawned ONLY 'second' — 'first' came from the journal cache", spawnsE.length === 1 && spawnsE[0] === 'second', spawnsE.join(','))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL DURABILITY CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
