#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'action-receipts-home-'))

await import('../../src/tasks.js')
const {
  registerWorkflowTask,
  pauseWorkflowTask,
  killWorkflowTask,
  skipWorkflowAgent,
  retryWorkflowAgent,
} = await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')
import type { LocalWorkflowTaskState } from '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Store = { state: { tasks: Record<string, unknown>; speculation: { status: string } } }
function makeStore(): Store & { set: (fn: (prev: never) => never) => void } {
  const store: Store & { set: (fn: (prev: never) => never) => void } = {
    state: { tasks: {}, speculation: { status: 'idle' } },
    set(fn) {
      store.state = (fn as (p: unknown) => Store['state'])(store.state)
    },
  }
  return store
}

function liveTask(store: Store, taskId: string): LocalWorkflowTaskState {
  return store.state.tasks[taskId] as LocalWorkflowTaskState
}

section('§A receipts speak the truth at the store')
{
  const store = makeStore()
  registerWorkflowTask({
    taskId: 'wf-recv',
    script: 'return 1',
    workflowRunId: 'run-recv',
    setAppState: store.set as never,
  })
  const ctrl = new AbortController()
  liveTask(store, 'wf-recv').agentControllers!.set('agA', ctrl)

  check("skip on an in-flight agent → 'applied'",
    skipWorkflowAgent('wf-recv', 'agA', store.set as never) === 'applied')
  check('…and the controller was signalled user-skip',
    ctrl.signal.aborted && ctrl.signal.reason === 'user-skip')
  check("skip AGAIN on the same agent → 'not-in-flight' (already settled)",
    skipWorkflowAgent('wf-recv', 'agA', store.set as never) === 'not-in-flight')
  check("retry on an unknown agent under a live run → 'not-in-flight'",
    retryWorkflowAgent('wf-recv', 'nosuch', store.set as never) === 'not-in-flight')

  check("pause on the running task → 'applied'",
    pauseWorkflowTask('wf-recv', store.set as never) === 'applied')
  check("pause AGAIN after the settle → 'run-settled'",
    pauseWorkflowTask('wf-recv', store.set as never) === 'run-settled')
  check("stop after the settle → 'run-settled' (never a claimed stop)",
    killWorkflowTask('wf-recv', store.set as never) === 'run-settled')
  check("skip after the settle → 'run-settled'",
    skipWorkflowAgent('wf-recv', 'agA', store.set as never) === 'run-settled')
}
{
  const store = makeStore()
  registerWorkflowTask({
    taskId: 'wf-recv2',
    script: 'return 1',
    workflowRunId: 'run-recv2',
    setAppState: store.set as never,
  })
  const ctrl = new AbortController()
  liveTask(store, 'wf-recv2').agentControllers!.set('agB', ctrl)
  check("retry on an in-flight agent → 'applied' with the user-retry reason",
    retryWorkflowAgent('wf-recv2', 'agB', store.set as never) === 'applied' &&
      ctrl.signal.reason === 'user-retry')
  check("stop on the running task → 'applied'",
    killWorkflowTask('wf-recv2', store.set as never) === 'applied')
}
{
  const store = makeStore()
  check("actions on a MISSING/evicted task → 'run-settled' (all four)",
    pauseWorkflowTask('ghost', store.set as never) === 'run-settled' &&
      killWorkflowTask('ghost', store.set as never) === 'run-settled' &&
      skipWorkflowAgent('ghost', 'x', store.set as never) === 'run-settled' &&
      retryWorkflowAgent('ghost', 'x', store.set as never) === 'run-settled')
}

section('§B the panes read the receipt (note wiring pins)')
{
  const run = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'RunDetailPane.tsx'),
    'utf8',
  )
  check('run view: every key acts through the one control request and its note reads the typed result',
    run.includes('void requestWorkflowControl(runDir, {') &&
      run.includes('setNote(resultWords(action, label, result))') &&
      run.includes("if (result.outcome === 'applied') return result.detail") &&
      run.includes("if (result.outcome === 'refused') return result.reason"))
  check('run view: a key that cannot act says why in one line, never success',
    run.includes('setNote(controlRefusal(input, status, orphaned, wedged))') &&
      run.includes('already settled — nothing to ${verb}') &&
      run.includes('already settled — nothing to ${verbWord(input)}'))
  check('run view: the pending word is spoken before the answer lands',
    run.includes('setNote(pendingWords(action, label))'))
  const board = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'WorkflowsBoard.tsx'),
    'utf8',
  )
  check('board: stop, pause and resume act through the one control request and fork on the typed result',
    (board.match(/run: \(r: RunRow\) => control\(r, '(stop|pause|resume)'\)/g) ?? []).length === 3 &&
      board.includes("result.outcome === 'applied' ? `${r.facts.name}: ${result.detail}` : `${r.facts.name}: ${result.reason}`"))
  const control = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'runControl.ts'),
    'utf8',
  )
  check('the channel answers the settled arm by name, never success',
    control.includes('already ${manifest.status === \'paused\' ? \'paused on disk\' : \'settled\'} — nothing to ${verbOf(input.action)}'))
  const tool = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'WorkflowTool.tsx'),
    'utf8',
  )
  check('the owner forks every action on the store receipt',
    (tool.match(/receipt === 'applied'/g) ?? []).length >= 4 &&
      tool.includes("'already settled — nothing to stop'") &&
      tool.includes("'the agent already settled — nothing to kill'") &&
      tool.includes("'the agent already settled — nothing to skip'") &&
      tool.includes("'the agent already settled — nothing to retry'"))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} ACTION-RECEIPT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL ACTION-RECEIPT PROOFS PASS')
