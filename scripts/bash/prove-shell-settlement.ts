#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distProvenance, distProvenanceLine } from '../lib/distProvenance.ts'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'settle-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH
process.on('exit', () => {
  try {
    rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
  } catch {
  }
})

const ROOT = join(import.meta.dir, '..', '..')
const { generateTaskId } = await import(join(ROOT, 'src/engine/tasks/taskBase.ts'))
const { TaskOutput } = await import(join(ROOT, 'src/engine/task-framework/taskOutput.ts'))
const { wrapSpawn, HARD_CAP_MULTIPLIER } = await import(
  join(ROOT, 'src/platform/shell/shellProcess.ts')
)
const { killTask } = await import(
  join(ROOT, 'src/engine/tasks/local-shell/killShellTasks.ts')
)
const { spawnShellTask } = await import(
  join(ROOT, 'src/engine/tasks/local-shell/shellTask.tsx')
)
const { findTaskOutcome } = await import(
  join(ROOT, 'src/engine/tasks/taskOutcomeEnvelope.ts')
)
const { getSessionId } = await import(join(ROOT, 'src/boot/process-state/processState.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = '', failHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && failHint ? ' — fix: ' + failHint : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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

section('XC-3 — interrupted is Mercury-kill-derived, never exit-code-derived')
{
  const child = spawn('sh', ['-c', 'exit 137'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const result = await cmd.result
  check('legal child exit(137) is NOT an interrupt', result.interrupted === false, `interrupted=${result.interrupted}`, 'wrapSpawn in src/platform/shell/shellProcess.ts must mark interrupted only when Mercury itself killed the command, never from the exit code')
  check('legal child exit(137) keeps its code', result.code === 137, `code=${result.code}`, 'wrapSpawn in src/platform/shell/shellProcess.ts must pass the child exit code through unchanged')
  cmd.cleanup()
}
{
  const child = spawn('sh', ['-c', 'exit 0'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const result = await cmd.result
  check('clean exit sanity: code 0, not interrupted', result.code === 0 && result.interrupted === false, '', 'wrapSpawn in src/platform/shell/shellProcess.ts reported a clean exit as a nonzero code or an interrupt')
  cmd.cleanup()
}
{
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const t0 = Date.now()
  cmd.kill()
  const result = await cmd.result
  const settleMs = Date.now() - t0
  check('Mercury kill() IS an interrupt', result.interrupted === true, `interrupted=${result.interrupted}`, 'the kill() of wrapSpawn in src/platform/shell/shellProcess.ts must set interrupted on the result')
  check('kill settles from the REAL exit (inside the 2s grace, not the fallback)', settleMs < 1_500, `settled in ${settleMs}ms`, 'wrapSpawn in src/platform/shell/shellProcess.ts must settle on the real process exit; KILL_GRACE_MS is the fallback after 2s')
  check('kill result carries the kill code', result.code === 137, `code=${result.code}`, 'a killed command in src/platform/shell/shellProcess.ts must settle with code 137')
  check("kill status is 'killed'", cmd.status === 'killed', `status=${cmd.status}`, 'kill() in src/platform/shell/shellProcess.ts must set status to killed')
  cmd.cleanup()
}
{
  const aborted = new AbortController()
  aborted.abort()
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, aborted.signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const t0 = Date.now()
  const result = await cmd.result
  check('a signal already aborted at spawn kills the command at once', result.interrupted === true && result.code === 137 && Date.now() - t0 < 1_500, `interrupted=${result.interrupted} code=${result.code} after ${Date.now() - t0}ms`, 'wrapSpawn in src/platform/shell/shellProcess.ts must kill at once when the signal is already aborted')
  cmd.cleanup()
}

section('Drain law — bytes written before exit are in the result (pipe mode)')
{
  const child = spawn('sh', ['-c', 'printf "head\\n"; printf "tail-marker-%s" done; exit 0'])
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const result = await cmd.result
  check('final pre-exit burst captured in result.stdout (exit precedes data callbacks — the owner drains one I/O tick)', result.stdout.includes('tail-marker-done'), JSON.stringify(result.stdout.slice(-80)), 'wrapSpawn in src/platform/shell/shellProcess.ts must drain output after the exit event before it settles the result')
  cmd.cleanup()
}

section('Process-group kill — descendants die with the leader (POSIX live)')
if (process.platform !== 'win32') {
  const child = spawn('sh', ['-c', 'sleep 600 & sleep 600'], { detached: true })
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  await sleep(150)
  cmd.kill()
  await cmd.result
  await sleep(200)
  let survivors = ''
  try {
    survivors = (await import('node:child_process')).execSync(
      `ps -eo pid=,pgid= | awk '$2 == ${child.pid}'`,
      { encoding: 'utf8' },
    ).trim()
  } catch {
    survivors = ''
  }
  check('no process in the killed group survives (leader + backgrounded grandchild)', survivors === '', survivors ? `survivors: ${survivors}` : '', 'kill() in src/platform/shell/shellProcess.ts must signal the whole process group, not only the leader')
  cmd.cleanup()
} else {
  console.log('  [SKIP] POSIX group-kill leg (win32 — the hosted windows-ui campaign proves taskkill /T)')
}

section('ST-2 — timeout auto-background re-arms the hard cap; operator background does not')
{
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 150, new TaskOutput(generateTaskId('local_bash'), null), true)
  let backgrounded = false
  cmd.onTimeout?.(backgroundFn => {
    backgrounded = backgroundFn(generateTaskId('local_bash'))
  })
  const t0 = Date.now()
  const result = await Promise.race([cmd.result, sleep(150 * HARD_CAP_MULTIPLIER + 2_500).then(() => null)])
  check('timeout converted to backgrounding first', backgrounded === true, '', 'the onTimeout callback of wrapSpawn in src/platform/shell/shellProcess.ts must hand a background function that returns true')
  check('hard cap killed the backgrounded task (no immortal background task)', result !== null, result === null ? `still running ${Date.now() - t0}ms after timeout` : `settled in ${Date.now() - t0}ms`, 'backgrounding a timed-out command in src/platform/shell/shellProcess.ts must re-arm the hard cap of HARD_CAP_MULTIPLIER times the timeout')
  if (result !== null) {
    check('deadline kill is a POLICY stop, not a user interrupt', result.interrupted === false, `interrupted=${result.interrupted}`, 'the hard-cap kill in src/platform/shell/shellProcess.ts must not set interrupted')
    check('deadline kill names the elapsed cap in stderr', result.stderr.includes('absolute deadline elapsed'), JSON.stringify(result.stderr.slice(0, 120)), 'the hard-cap kill message in src/platform/shell/shellProcess.ts must contain absolute deadline elapsed')
  }
  child.kill('SIGKILL')
  cmd.cleanup()
}
{
  const child = spawn('sleep', ['600'])
  const cmd = wrapSpawn(child, new AbortController().signal, 120, new TaskOutput(generateTaskId('local_bash'), null), true)
  let lateBackgroundAccepted: boolean | null = null
  cmd.onTimeout?.(backgroundFn => {
    lateBackgroundAccepted = backgroundFn(generateTaskId('local_bash'))
  })
  check('operator background accepted while running', cmd.background(generateTaskId('local_bash')) === true, '', 'background() of wrapSpawn in src/platform/shell/shellProcess.ts must return true while the command runs')
  await sleep(120 * HARD_CAP_MULTIPLIER + 800)
  check('operator background tore down the foreground timer (timeout never fired)', lateBackgroundAccepted === null, `lateBackgroundAccepted=${lateBackgroundAccepted}`, 'background() in src/platform/shell/shellProcess.ts must clear the foreground timeout timer')
  check('operator-backgrounded task has NO deadline (service semantics)', cmd.status === 'backgrounded', `status=${cmd.status}`, 'an operator-backgrounded command in src/platform/shell/shellProcess.ts must keep status backgrounded with no hard cap')
  child.kill('SIGKILL')
  await cmd.result
  cmd.cleanup()
}

section('ST-6 — no phantom background task for an already-exited process')
{
  const child = spawn('true')
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  await cmd.result
  check('owner contract: background() on an exited command returns false', cmd.background(generateTaskId('local_bash')) === false, '', 'background() in src/platform/shell/shellProcess.ts must return false once the command has exited')
  cmd.cleanup()
}
{
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
  check('task registered under the TaskOutput taskId', task !== undefined, '', 'spawnShellTask in src/engine/tasks/local-shell/shellTask.tsx must register the task under the taskId of the shell command output')
  check("phantom suppressed: settled status, not 'running'", task?.status === 'failed', `status=${task?.status}`, 'spawnShellTask in src/engine/tasks/local-shell/shellTask.tsx must settle an already-exited command instead of registering it running')
  check('settled from the REAL result (code 7 preserved)', task?.result?.code === 7, `code=${task?.result?.code}`, 'spawnShellTask in src/engine/tasks/local-shell/shellTask.tsx must store the real command result on the settled task')
  check('marked notified — no duplicate task notification', task?.notified === true, '', 'spawnShellTask in src/engine/tasks/local-shell/shellTask.tsx must set notified on a task it settles at spawn')
  check('shellCommand reference released', task?.shellCommand === null, '', 'spawnShellTask in src/engine/tasks/local-shell/shellTask.tsx must set shellCommand to null on a settled task')
  const env = await awaitTaskOutcome(getSessionId(), handle.taskId)
  check('envelope minted at the terminal transition (failed, exit 7)', env?.state === 'failed' && env?.exitCode === 7, JSON.stringify(env)?.slice(0, 100), 'the terminal transition of the task must mint an outcome envelope that findTaskOutcome in src/engine/tasks/taskOutcomeEnvelope.ts can read')
}

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
  check("killTask receipt: settled with the real exit code and the stop's provenance", receipt.settled === true && (receipt as any).exitCode === 137 && (receipt as any).interrupted === true, JSON.stringify(receipt), 'killTask in src/engine/tasks/local-shell/killShellTasks.ts must resolve only after the real exit, with exitCode 137 and interrupted true')
  check("task state flipped to 'killed'", state.tasks[handle.taskId]?.status === 'killed', `status=${state.tasks[handle.taskId]?.status}`, 'killTask in src/engine/tasks/local-shell/killShellTasks.ts must set the task status to killed')
  const killedEnv = await awaitTaskOutcome(getSessionId(), handle.taskId)
  check("killed task's envelope minted as 'stopped' with the real exit", killedEnv?.state === 'stopped' && killedEnv?.exitCode === 137, JSON.stringify(killedEnv)?.slice(0, 100), 'a killed task must mint an envelope with state stopped and the real exit code; findTaskOutcome is in src/engine/tasks/taskOutcomeEnvelope.ts')
}
{
  let state: { tasks: Record<string, any> } = { tasks: {} }
  const receipt = await killTask('task-does-not-exist', (f: (prev: any) => any) => {
    state = f(state)
  })
  check('killTask on a non-running task: honest not-running receipt', receipt.settled === true && (receipt as any).reason === 'not-running', JSON.stringify(receipt), 'killTask in src/engine/tasks/local-shell/killShellTasks.ts must return a settled not-running receipt for an unknown task id')
}

{
  const provenance = distProvenance(ROOT)
  console.log(`  ${distProvenanceLine(provenance)}`)
  if (provenance.kind === 'own') {
    const dist = readFileSync(join(ROOT, 'dist', 'mercury.mjs'), 'utf8')
    const pins = [
      'absolute deadline elapsed',
      'and was moved to the background with ID',
    ]
    const stale = pins.filter(p => !dist.includes(p))
    check('dist carries the SM-B caller-layer literals', stale.length === 0, stale.length ? `missing from a CURRENT dist: ${stale.join(', ')}` : '', 'rebuild with bun run build.ts, or restore the missing literals in src/platform/shell/shellProcess.ts and src/tools/shell/resultBlock.ts')
  }
}

section('ST-5 — decision parsing survives the pipe-mode spill (live)')
{
  const out = new TaskOutput(generateTaskId('local_bash'), null)
  const decision = JSON.stringify({ decision: 'block', reason: 'st5-proof-' + 'x'.repeat(5000) })
  out.writeStdout(decision + '\n')
  out.writeStdout('after-1\nafter-2\nafter-3\nafter-4\nafter-5\nafter-6\n')
  out.spillToDisk()
  const tailView = await out.getStdout()
  const fullView = await out.getStdoutForDecision()
  check('tail view (prompt-bound) does NOT carry the buried decision', !tailView.includes('st5-proof-'), 'tail view unexpectedly complete — spill semantics changed?', 'spillToDisk in src/engine/task-framework/taskOutput.ts must leave getStdout as the tail only')
  check('getStdoutForDecision recovers the full JSON decision line', fullView.split('\n').some(l => {
    if (!l.trim().startsWith('{')) return false
    try {
      return JSON.parse(l.trim()).reason?.startsWith('st5-proof-') === true
    } catch {
      return false
    }
  }), `fullView ${fullView.length} chars`, 'getStdoutForDecision in src/engine/task-framework/taskOutput.ts must read the full output file after a spill')
  await out.deleteOutputFile()
}


console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL SHELL SETTLEMENT PROOFS PASS')
} else {
  console.log(` ❌ ${failures} SHELL SETTLEMENT PROOF(S) FAILED`)
}
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
