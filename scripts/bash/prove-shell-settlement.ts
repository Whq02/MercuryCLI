#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-shell-settlement.ts
//  PROOF: — shell task settlement truth at the ShellCommand /
//  LocalShellTask owners, plus source+dist pins for the BashTool caller layer.
//
//  The four truth laws under proof:
//    - a deadline belongs to the TASK: timeout→auto-background is a
//      presentation transition and re-arms the absolute hard cap (ST-2);
//      an operator-chosen background (Ctrl+B / run_in_background) is service
//      semantics — no cap, only the size watchdog;
//    - `interrupted` derives from Mercury's OWN kill state, never from the
//      child's numeric exit — a legal exit(137) (docker OOM, `timeout -s
//      KILL`) is the child's outcome, not a user interrupt (XC-3);
//    - a kill request is not settlement: the result settles from the REAL
//      exit event (bounded by the kill grace), and killTask returns a typed
//      KillSettlement receipt (fixture §10.19);
//    - background() on an exited process is refused and the CALLER settles
//      the registered state instead of minting a phantom task (ST-6).
//
//  LOADABILITY (memory/bun-run-proof-loadability): ShellCommand.ts,
//  killShellTasks.ts and LocalShellTask.tsx all load under bare `bun run`
// those laws are proven LIVE with real processes.
//  BashTool.tsx does NOT load (transitive feature() macro), so the caller-
//  layer invariants (ST-1 interrupt branch, XC-4 gating, the ST-2 model
//  message) are pinned in SOURCE and, when built, in dist/mercury.mjs
//  (host-harness law: grep dist with fixed strings; skip cleanly when absent).
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Proof hygiene: the task-layer legs now MINT TaskOutcomeEnvelopes at their
// terminal transitions — pin the config home to a scratch root BEFORE the
// imports so those writes never land in the operator's real home.
const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'settle-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH
process.on('exit', () => {
  try {
    rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const ROOT = join(import.meta.dir, '..', '..')
const { generateTaskId } = await import(join(ROOT, 'src/Task.ts'))
const { TaskOutput } = await import(join(ROOT, 'src/utils/task/TaskOutput.ts'))
const { wrapSpawn, HARD_CAP_MULTIPLIER } = await import(
  join(ROOT, 'src/utils/ShellCommand.ts')
)
const { killTask } = await import(
  join(ROOT, 'src/tasks/LocalShellTask/killShellTasks.ts')
)
const { spawnShellTask } = await import(
  join(ROOT, 'src/tasks/LocalShellTask/LocalShellTask.tsx')
)
const { findTaskOutcome } = await import(
  join(ROOT, 'src/tasks/taskOutcomeEnvelope.ts')
)
const { getSessionId } = await import(join(ROOT, 'src/bootstrap/state.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Await a fire-and-forget envelope mint on its SETTLED-PHASE observable —
 *  the durable file itself. The mint rides a
 *  separate continuation of the settlement promise through flushAndCleanup
 *  plus the durable publish — BOTH fs-bound — so a fixed wall sleep races
 *  disk and loses on a stretched runner (the killed-task envelope was absent
 *  250ms after an honest kill receipt). Poll on counted 20ms wakeups
 *  (granted time, stall-immune); the budget still reds a mint that never
 *  fires, so the check keeps its teeth. */
async function awaitTaskOutcome(
  sessionId: string,
  taskId: string,
  budgetMs = 10_000,
): Promise<any> {
  let ticks = Math.ceil(budgetMs / 20)
  for (;;) {
    const env = await findTaskOutcome(sessionId, taskId)
    if (env || ticks-- <= 0) return env
    await sleep(20)
  }
}

console.log('============================================================')
console.log(' Shell settlement truth — proof')
console.log('============================================================')

// ── XC-3: interrupted derives from Mercury kill state, not exit code ───────
section('XC-3 — interrupted is Mercury-kill-derived, never exit-code-derived')
{
  const child = spawn('sh', ['-c', 'exit 137'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const result = await cmd.result
  check('legal child exit(137) is NOT an interrupt', result.interrupted === false, `interrupted=${result.interrupted}`)
  check('legal child exit(137) keeps its code', result.code === 137, `code=${result.code}`)
  cmd.cleanup()
}
{
  const child = spawn('sh', ['-c', 'exit 0'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const result = await cmd.result
  check('clean exit sanity: code 0, not interrupted', result.code === 0 && result.interrupted === false)
  cmd.cleanup()
}
{
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const t0 = Date.now()
  cmd.kill()
  const result = await cmd.result
  const settleMs = Date.now() - t0
  check('Mercury kill() IS an interrupt', result.interrupted === true, `interrupted=${result.interrupted}`)
  check('kill settles from the REAL exit (inside the 2s grace, not the fallback)', settleMs < 1_500, `settled in ${settleMs}ms`)
  check('kill result carries the kill code', result.code === 137, `code=${result.code}`)
  check("kill status is 'killed'", cmd.status === 'killed', `status=${cmd.status}`)
  cmd.cleanup()
}

// ── exit → drain → result: the final burst is in the settled result ────────
section('Drain law — bytes written before exit are in the result (pipe mode)')
{
  const child = spawn('sh', ['-c', 'printf "head\\n"; printf "tail-marker-%s" done; exit 0'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const result = await cmd.result
  check('final pre-exit burst captured in result.stdout (exit precedes data callbacks — the owner drains one I/O tick)', result.stdout.includes('tail-marker-done'), JSON.stringify(result.stdout.slice(-80)))
  cmd.cleanup()
}

// ── Group kill: no descendant survives a Mercury kill ──────────────────────
section('Process-group kill — descendants die with the leader (POSIX live)')
if (process.platform !== 'win32') {
  // A detached shell + a background grandchild in the SAME group. The group
  // signal must reap both — a snapshot ps-walk alone could race a fresh fork.
  const child = spawn('sh', ['-c', 'sleep 600 & sleep 600'], { detached: true })
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  await sleep(150) // let the grandchild fork
  cmd.kill()
  await cmd.result
  await sleep(200) // let the group signal deliver
  let survivors = ''
  try {
    survivors = (await import('node:child_process')).execSync(
      `ps -eo pid=,pgid= | awk '$2 == ${child.pid}'`,
      { encoding: 'utf8' },
    ).trim()
  } catch {
    survivors = ''
  }
  check('no process in the killed group survives (leader + backgrounded grandchild)', survivors === '', survivors ? `survivors: ${survivors}` : '')
  cmd.cleanup()
} else {
  console.log('  [SKIP] POSIX group-kill leg (win32 — the hosted windows-ui campaign proves taskkill /T)')
}

// ── ST-2: the absolute deadline survives timeout→auto-background ───────────
section('ST-2 — timeout auto-background re-arms the hard cap; operator background does not')
{
  // Timeout 150ms, auto-background accepted → the hard cap (10×150ms = 1.5s)
  // must kill it. At the kickoff tree this leg FAILED: the fired timer was
  // cleared and only the 5GB size watchdog remained — an immortal task.
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 150, new TaskOutput(generateTaskId('local_bash'), null), true)
  let backgrounded = false
  cmd.onTimeout?.(backgroundFn => {
    backgrounded = backgroundFn(generateTaskId('local_bash'))
  })
  const t0 = Date.now()
  const result = await Promise.race([cmd.result, sleep(150 * HARD_CAP_MULTIPLIER + 2_500).then(() => null)])
  check('timeout converted to backgrounding first', backgrounded === true)
  check('hard cap killed the backgrounded task (no immortal background task)', result !== null, result === null ? `still running ${Date.now() - t0}ms after timeout` : `settled in ${Date.now() - t0}ms`)
  if (result !== null) {
    check('deadline kill is a POLICY stop, not a user interrupt', result.interrupted === false, `interrupted=${result.interrupted}`)
    check('deadline kill names the elapsed cap in stderr', result.stderr.includes('absolute deadline elapsed'), JSON.stringify(result.stderr.slice(0, 120)))
  }
  child.kill('SIGKILL')
  cmd.cleanup()
}
{
  // Operator-chosen background BEFORE the timeout fires: background() tears
  // down the foreground timer (an EXPLICIT user change — truth-law 2 allows
  // it), so the timeout never fires and NO cap is armed. 10×120ms = 1.2s:
  // still alive well past that.
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 120, new TaskOutput(generateTaskId('local_bash'), null), true)
  let lateBackgroundAccepted: boolean | null = null
  cmd.onTimeout?.(backgroundFn => {
    lateBackgroundAccepted = backgroundFn(generateTaskId('local_bash'))
  })
  check('operator background accepted while running', cmd.background(generateTaskId('local_bash')) === true)
  await sleep(120 * HARD_CAP_MULTIPLIER + 800)
  check('operator background tore down the foreground timer (timeout never fired)', lateBackgroundAccepted === null, `lateBackgroundAccepted=${lateBackgroundAccepted}`)
  check('operator-backgrounded task has NO deadline (service semantics)', cmd.status === 'backgrounded', `status=${cmd.status}`)
  child.kill('SIGKILL')
  await cmd.result
  cmd.cleanup()
}

// ── ST-6: background() refused after exit; the caller settles honestly ─────
section('ST-6 — no phantom background task for an already-exited process')
{
  const child = spawn('true')
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  await cmd.result
  check('owner contract: background() on an exited command returns false', cmd.background(generateTaskId('local_bash')) === false)
  cmd.cleanup()
}
{
  // Caller law (LocalShellTask.spawnShellTask): the refused background()
  // settles the registered state from the resolved result — never a
  // 'running' phantom plus a duplicate notification.
  const child = spawn('sh', ['-c', 'exit 7'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  await cmd.result
  let state: { tasks: Record<string, any> } = { tasks: {} }
  const setAppState = (f: (prev: any) => any): void => {
    state = f(state)
  }
  const handle = await spawnShellTask(
    { command: 'exit 7', description: 'st6-caller', shellCommand: cmd },
    { abortController: new AbortController(), getAppState: () => state, setAppState } as any,
  )
  const task = state.tasks[handle.taskId]
  check('task registered under the TaskOutput taskId', task !== undefined)
  check("phantom suppressed: settled status, not 'running'", task?.status === 'failed', `status=${task?.status}`)
  check('settled from the REAL result (code 7 preserved)', task?.result?.code === 7, `code=${task?.result?.code}`)
  check('marked notified — no duplicate task notification', task?.notified === true)
  check('shellCommand reference released', task?.shellCommand === null)
  //  wiring: the terminal transition MINTED the durable envelope
  // (fire-and-forget — await the file, the settled-phase observable).
  const env = await awaitTaskOutcome(getSessionId(), handle.taskId)
  check('envelope minted at the terminal transition (failed, exit 7)', env?.state === 'failed' && env?.exitCode === 7, JSON.stringify(env)?.slice(0, 100))
}

// ── Fixture §10.19: killTask returns a typed settlement receipt ────────────
section('Kill settlement receipt — a stop request is not settlement')
{
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  let state: { tasks: Record<string, any> } = { tasks: {} }
  const setAppState = (f: (prev: any) => any): void => {
    state = f(state)
  }
  const handle = await spawnShellTask(
    { command: 'sleep 600', description: 'kill-receipt', shellCommand: cmd },
    { abortController: new AbortController(), getAppState: () => state, setAppState } as any,
  )
  check('live task registered running', state.tasks[handle.taskId]?.status === 'running')
  const receipt = await killTask(handle.taskId, setAppState)
  check("killTask receipt: settled with the real exit code and the stop's provenance", receipt.settled === true && (receipt as any).exitCode === 137 && (receipt as any).interrupted === true, JSON.stringify(receipt))
  check("task state flipped to 'killed'", state.tasks[handle.taskId]?.status === 'killed', `status=${state.tasks[handle.taskId]?.status}`)
  //  wiring: a KILLED task still mints its terminal envelope
  // (state 'stopped' — only verification credit is withheld). The mint rides
  // shellCommand.result's OTHER continuation (flushAndCleanup + durable
  // publish), so the receipt above can resolve well before the file lands —
  // await the observable, never a fixed wall sleep.
  const killedEnv = await awaitTaskOutcome(getSessionId(), handle.taskId)
  check("killed task's envelope minted as 'stopped' with the real exit", killedEnv?.state === 'stopped' && killedEnv?.exitCode === 137, JSON.stringify(killedEnv)?.slice(0, 100))
}
{
  let state: { tasks: Record<string, any> } = { tasks: {} }
  const receipt = await killTask('task-does-not-exist', (f: (prev: any) => any) => {
    state = f(state)
  })
  check('killTask on a non-running task: honest not-running receipt', receipt.settled === true && (receipt as any).reason === 'not-running', JSON.stringify(receipt))
}

// ── Caller-layer pins (BashTool.tsx is not bun-run loadable) ───────────────
section('ST-1 / XC-4 / ST-2-message — source pins at the BashTool caller')
{
  const bashToolSrc = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
  const psToolSrc = readFileSync(join(ROOT, 'src/tools/PowerShellTool/PowerShellTool.tsx'), 'utf8')
  check('ST-1: Bash progress loop has the interrupt-backgrounding branch', bashToolSrc.includes("!interruptBackgroundingStarted && abortController.signal.reason === 'interrupt'"))
  check('ST-1: PowerShell twin branch still present (parity)', psToolSrc.includes("!interruptBackgroundingStarted && abortController.signal.reason === 'interrupt'"))
  check('ST-1: interrupt-steer hands the model the output so far', bashToolSrc.includes("interruptBackgroundingStarted ? fullOutput : ''"))
  const gitGate = /if \(result\.backgroundTaskId === undefined\) \{\s*\n\s*trackGitOperations\(/m.test(bashToolSrc)
  const auditGate = /if \(result\.backgroundTaskId === undefined\) \{\s*\n\s*recordBashAudit\(/m.test(bashToolSrc)
  check('XC-4: trackGitOperations gated on a settled (non-backgrounded) result', gitGate)
  check('XC-4: recordBashAudit gated on a settled (non-backgrounded) result', auditGate)
  check('ST-2: timeout-backgrounded model message names the elapsed timeout + hard cap', bashToolSrc.includes('and was moved to the background with ID') && bashToolSrc.includes('absolute deadline of'))
  check('ST-2: timeout marker threads through the result contract', bashToolSrc.includes('timeoutAutoBackgroundedAfterMs'))
  // PowerShell pre-flight failures are typed NOT-STARTED —
  // never exit 0. Both legs carry preSpawnError (call() throws it) + 127.
  const preflightBlocks = psToolSrc.split('preSpawnError:')
  check('SM-04: pwsh-not-found and spawn-catch legs carry preSpawnError (typed not-started)', preflightBlocks.length >= 3)
  check('SM-04: no pre-flight leg fabricates code 0 (not-started is never exit 0)', !/Pre-flight failure[\s\S]{0,400}?code: 0/m.test(psToolSrc))
  check('SM-04/XC-4: PowerShell git tracking gated on executed, settled results', psToolSrc.includes('const notExecuted = result.preSpawnError !== undefined || result.backgroundTaskId !== undefined'))
}
{
  const distPath = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(distPath)) {
    console.log('  [SKIP] dist/mercury.mjs not built — dist pins skipped (pool Phase 0 rebuilds it)')
  } else {
    // Stale-dist guard: a dist older than the pinned sources predates the
    // change and would false-RED a solo run. The pool rebuilds dist in
    // Phase 0, so in the gate this leg is always strict.
    const { statSync } = await import('node:fs')
    const newestSrc = Math.max(
      statSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx')).mtimeMs,
      statSync(join(ROOT, 'src/utils/ShellCommand.ts')).mtimeMs,
    )
    if (statSync(distPath).mtimeMs < newestSrc) {
      console.log('  [SKIP] dist/mercury.mjs is OLDER than the pinned sources — stale build; dist pins skipped (rebuild or run in the pool for the strict leg)')
    } else {
      const dist = readFileSync(distPath, 'utf8')
      const pins = [
        'absolute deadline elapsed',
        'and was moved to the background with ID',
      ]
      const stale = pins.filter(p => !dist.includes(p))
      check('dist carries the SM-B caller-layer literals', stale.length === 0, stale.length ? `missing from a CURRENT dist: ${stale.join(', ')}` : '')
    }
  }
}

// ── ST-5 LIVE: spilled async-hook output keeps its decision ────────────────
section('ST-5 — decision parsing survives the pipe-mode spill (live)')
{
  const out = new TaskOutput(generateTaskId('local_bash'), null)
  // Pipe mode: write a >4KB JSON decision line, bury it >5 lines deep behind
  // trailing chatter, then spill — the exact shape that would otherwise parse to {}.
  const decision = JSON.stringify({ decision: 'block', reason: 'st5-proof-' + 'x'.repeat(5000) })
  out.writeStdout(decision + '\n')
  out.writeStdout('after-1\nafter-2\nafter-3\nafter-4\nafter-5\nafter-6\n')
  out.spillToDisk()
  const tailView = await out.getStdout()
  const fullView = await out.getStdoutForDecision()
  check('tail view (prompt-bound) does NOT carry the buried decision', !tailView.includes('st5-proof-'), 'tail view unexpectedly complete — spill semantics changed?')
  check('getStdoutForDecision recovers the full JSON decision line', fullView.split('\n').some(l => {
    if (!l.trim().startsWith('{')) return false
    try {
      return JSON.parse(l.trim()).reason?.startsWith('st5-proof-') === true
    } catch {
      return false
    }
  }), `fullView ${fullView.length} chars`)
  await out.deleteOutputFile()
}

// ── Satellite pins: settlement-class fixes at bun-run-unloadable owners ────
section('ST-3/4/7/8, XC-1/2 — source pins at their owners')
{
  const pins: [string, string, (src: string) => boolean][] = [
    // Pin over runAgent: the claim map is
    // `executorClaims` and the finally compares the held symbol inline — same law
    // (teardown only while the claim is still held), Mercury spellings.
    ['ST-3: runAgent finally gates shared teardown on the executor claim', 'src/tools/AgentTool/runAgent.ts', s => s.includes('executorClaims') && /executorClaims\.get\(agentId\) === claim/.test(s)],
    ['ST-4: Monitor stop latch defers past pending stdio (setImmediate)', 'src/tools/MonitorTool/MonitorTool.ts', s => /result\.then\(async \(\) => \{[\s\S]{0,400}?setImmediate[\s\S]{0,200}?stopped = true/m.test(s)],
    ['ST-7: workflow output write is awaited before the notification', 'src/tools/WorkflowTool/WorkflowTool.tsx', s => s.includes('await completeWorkflowTask(')],
    ['ST-7: write failure reaches the notification args', 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx', s => s.includes('outputWriteError') && s.includes('the output file could not be written')],
    ['ST-8: daemon grace-kill settles from close (backstop-bounded), not finish(null)', 'src/daemon/headlessRun.ts', s => s.includes('finishOnCloseWithBackstop()') && !/SIGKILL'\)\s*\n\s*finish\(null\)/m.test(s)],
    // XC-1 re-trued at the /rewind fold: the per-file copy loop (which could
    // half-apply and then throw) is deleted whole — the restore rides the
    // change-transaction commit core all-or-nothing, with the typed refusal
    // vocabulary carrying the partial-restore class instead of a throw.
    ['XC-1: the restore is all-or-nothing on the commit core with typed refusals (the partial-restore class cannot exist)', 'src/utils/fileHistory.ts', s => s.includes('runTextChangeSetCommit') && s.includes("'restore-failed'")],
    ['XC-2: keychain delete reads the exit code (44 = idempotent success; SM-J delete-both loop)', 'src/utils/secureStorage/macOsKeychainStorage.ts', s => s.includes('result.exitCode !== 0 && result.exitCode !== 44') && s.includes('getLegacyMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)')],
    ['XC-5: kernel death settles on close with tail flush (backstop-bounded)', 'src/services/workshop/pythonRuntime.ts', s => s.includes("child.on('close', settleKernelExit)") && s.includes('kernelExitSettled')],
    ['PB-6: kernel host line buffer bounded + runner chunk-emits past 1MB', 'src/services/workshop/pythonRuntime.ts', s => s.includes('MAX_KERNEL_LINE_BYTES')],
    ['PB-6: runner-side chunk-emit threshold present', 'src/services/workshop/pythonRunnerSource.ts', s => s.includes('_MAX_OUT_BUF')],
    ['PB-5: tcp bridge exits via drain + backstop, never a truncating exit(0) on close', 'src/services/tcpBridge/entry.ts', s => s.includes('process.exitCode = 0') && !s.includes("socket.on('close', () => process.exit(0))")],
    // XC-6 re-trued at the release-blockers fold: the driver rides the ONE
    // settle owner (settle on exit inside a bounded drain; the timeout's
    // forced end routes through the tree kill and keeps the early resolve) —
    // the close-drain law now lives in utils/childSettle, pinned by its own
    // prover.
    ['XC-6: cmake settles through the shared settle owner (close-drain + bounded timeout live in childSettle)', 'src/services/ide/cppBuild.ts', s => s.includes('settleChildRun(child, { timeoutMs })')],
    ['XC-7: a failed headersHelper fails the connection, never silent no-auth', 'src/services/mcp/headersHelper.ts', s => s.includes('The connection was not attempted without its auth headers')],
    ['PB-2: DAP partial-output keep-tail bounded, \\r is a boundary', 'src/services/dap/dapClient.ts', s => s.includes('#PARTIAL_OUTPUT_KEEP_BYTES') && s.includes('search(/[\\r\\n]/)')],
    ['WP-5: win32 clipboard verdict in the EXIT CODE; save fails when raced empty; path apostrophe-escaped', 'src/utils/imagePaste.ts', s => s.includes('if ($null -eq $img) { exit 1 }; exit 0') && s.includes('[System.Drawing.Imaging.ImageFormat]::Png); exit 0') && s.includes('path.replace(/\'/g, "\'\'")')],
    ['SM-B: TaskStop surfaces the settlement receipt (settled/exit_code), never a bare ack', 'src/tools/TaskStopTool/TaskStopTool.ts', s => s.includes('settled: result.settlement.settled') && s.includes('had not settled within the grace window')],
    ['SM-B: stopTask validates + threads the kill receipt', 'src/tasks/stopTask.ts', s => s.includes("typeof (killReturn as { settled?: unknown }).settled === 'boolean'")],
  ]
  for (const [label, file, test] of pins) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    check(label, test(src))
  }
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL SHELL SETTLEMENT PROOFS PASS')
} else {
  console.log(` ❌ ${failures} SHELL SETTLEMENT PROOF(S) FAILED`)
}
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
