#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-action-receipts.ts — action receipts.
//
//  What the code did vs the invariant it missed: skip/retry/pause/stop
//  returned booleans that every call site discarded, printing a positive
//  note even when the run or the agent had settled between render and
//  keypress — a structural window, not a rare race.
//
//  The invariant: an operator action returns a typed receipt
//  ('applied' | 'run-settled' | 'not-in-flight') and the panes' notes read
//  it, so no note claims an effect that touched nothing.
//
//  Seams: the real store actions (LocalWorkflowTask) + source pins on the
//  two panes' note wiring (single-line notes on existing rows — the render
//  floor is owned by prove-workflows-board's scenarios).
// ============================================================================
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
  check('run view: all four actions bind their receipt',
    (run.match(/const receipt = (skip|retry|pause|kill)Workflow(Agent|Task)\(/g) ?? []).length === 4,
    String((run.match(/const receipt = /g) ?? []).length))
  check("run view: every note forks on receipt === 'applied'",
    (run.match(/receipt === 'applied'/g) ?? []).length >= 4)
  check('run view: the settled arm says nothing-to-act, never success',
    run.includes('the run already settled — nothing to pause') &&
      run.includes('the run already settled — nothing to stop') &&
      run.includes('already settled — nothing to skip') &&
      run.includes('already settled — nothing to retry'))
  const board = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'WorkflowsBoard.tsx'),
    'utf8',
  )
  check('board: stop + pause bind and fork on the receipt',
    (board.match(/const receipt = (kill|pause)WorkflowTask\(/g) ?? []).length === 2 &&
      (board.match(/receipt === 'applied'/g) ?? []).length >= 2)
  check('board: the settled arms say nothing-to-act',
    board.includes('already settled — nothing to stop') &&
      board.includes('already settled — nothing to pause'))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} ACTION-RECEIPT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL ACTION-RECEIPT PROOFS PASS')
