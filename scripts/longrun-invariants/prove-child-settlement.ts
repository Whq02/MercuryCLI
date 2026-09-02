#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-child-settlement.ts — child states under a settled
//  parent.
//
//  What the code did vs the invariant it missed: a pause/stop/fail/complete
//  settles the parent workflow task and stops accepting later child frames
//  (updateWorkflowProgressBatch early-returns on any non-running status), so
//  agents still 'start'/'progress' at that moment kept an in-flight word
//  FOREVER — in AppState and in the persisted run.json (the terminal
//  writeManifest projects the same array via buildAgentSummaries). And the
//  state vocabulary had no 'stopped'/'skipped' member, so an operator skip
//  could only be spelled as an ERROR frame.
//
//  The invariant: a settled parent leaves NO in-flight child words behind, and
//  a deliberate operator settle (skip) is never rendered with the fault tone.
//
//  Seams proven (all production):
//   §A the task store — registerWorkflowTask / updateWorkflowProgressBatch /
//      pause+kill+fail+complete transitions / buildAgentSummaries
//   §B the executor skip path — real makeWorkflowHooks with a scripted
//      spawnSubagentStream (the prove-stall-liveness rig), controller aborted
//      'user-skip' mid-flight
//   §C the pane grammar — agentSnapshotState / phaseTone / settledCount
//      (the words the /workflows panes speak; render pinned separately by
//      scripts/ui/prove-workflows-board.ts workflows-live-settled)
//
//  Hermetic: MERCURY_CONFIG_DIR pinned to a scratch mkdtemp outside the repo.
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'child-settlement-home-'))

// Enter via the task registry FIRST — importing the task module directly makes
// it the process entry inside its own import cycle (the documented TDZ; see
// prove-ref-observability's registry note).
await import('../../src/tasks.js')
const {
  registerWorkflowTask,
  updateWorkflowProgressBatch,
  pauseWorkflowTask,
  killWorkflowTask,
  failWorkflowTask,
  completeWorkflowTask,
} = await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')
const { buildAgentSummaries } = await import('../../src/tools/WorkflowTool/runManifest.js')
const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')
const { agentSnapshotState } = await import('../../src/components/tasks/WorkflowDetailDialog.js')
const { phaseTone } = await import('../../src/components/tasks/workflowRollup.js')
const { settledCount } = await import('../../src/components/tasks/RunDetailPane.js')
const { STATE_STYLE } = await import('../../src/components/mercury-ui/theme.js')

import type { LocalWorkflowTaskState, WorkflowProgressEvent } from '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── §A the task store: every settle projects its stranded children ──────────
section('§A a settled parent leaves no in-flight child words (the store seam)')

type Store = { state: { tasks: Record<string, unknown> } & Record<string, unknown> }
function makeStore(): Store & { set: (fn: (prev: never) => never) => void } {
  const store: Store & { set: (fn: (prev: never) => never) => void } = {
    // speculation: the kill path's abortSpeculation reads it (idle = no-op)
    state: { tasks: {}, speculation: { status: 'idle' } },
    set(fn) {
      store.state = (fn as (p: unknown) => Store['state'])(store.state)
    },
  }
  return store
}

const agentFrame = (
  index: number,
  state: 'start' | 'progress' | 'done',
): WorkflowProgressEvent => ({
  type: 'workflow_agent',
  index,
  label: `agent-${index}`,
  state,
  agentId: `ag${index}`,
  ...(state === 'done' ? { durationMs: 1000, tokens: 10 } : {}),
})

function settleCase(
  name: string,
  settle: (taskId: string, set: never) => void,
  expectStatus: string,
): void {
  const store = makeStore()
  const taskId = `wf-task-${name}`
  registerWorkflowTask({
    taskId,
    script: 'return 1',
    workflowRunId: `run-${name}`,
    setAppState: store.set as never,
  })
  updateWorkflowProgressBatch(
    taskId,
    [agentFrame(1, 'start'), agentFrame(2, 'progress'), agentFrame(3, 'done')],
    store.set as never,
  )
  settle(taskId, store.set as never)
  const task = store.state.tasks[taskId] as LocalWorkflowTaskState
  check(`${name}: parent status settled '${expectStatus}'`, task.status === expectStatus, task.status)
  const states = new Map(
    task.workflowProgress
      .filter(ev => ev.type === 'workflow_agent')
      .map(ev => [ev.index, (ev as { state: string }).state]),
  )
  check(`${name}: queued child (start) projected 'stopped'`, states.get(1) === 'stopped', String(states.get(1)))
  check(`${name}: running child (progress) projected 'stopped'`, states.get(2) === 'stopped', String(states.get(2)))
  check(`${name}: settled child (done) untouched`, states.get(3) === 'done', String(states.get(3)))
  // the persisted manifest rows are a projection of the SAME array
  const rows = buildAgentSummaries(task.workflowProgress)
  check(
    `${name}: buildAgentSummaries carries the projection (no in-flight rows)`,
    rows.every(r => r.state !== 'start' && r.state !== 'progress'),
    JSON.stringify(rows.map(r => [r.index, r.state])),
  )
  // later frames still dropped — the settle boundary law is unchanged
  updateWorkflowProgressBatch(taskId, [agentFrame(2, 'done')], store.set as never)
  const after = store.state.tasks[taskId] as LocalWorkflowTaskState
  const post = after.workflowProgress.find(
    ev => ev.type === 'workflow_agent' && ev.index === 2,
  ) as { state: string } | undefined
  check(`${name}: post-settle frames still dropped`, post?.state === 'stopped', String(post?.state))
}

settleCase('pause', (id, set) => void pauseWorkflowTask(id, set), 'paused')
settleCase('kill', (id, set) => void killWorkflowTask(id, set), 'killed')
settleCase('fail', (id, set) => void failWorkflowTask(id, 'boom', 3, [], set), 'failed')
settleCase('complete', (id, set) => void completeWorkflowTask(id, { ok: true }, 3, [], set), 'completed')

{
  // no stranded children ⇒ the array reference is preserved (no phantom churn)
  const store = makeStore()
  registerWorkflowTask({
    taskId: 'wf-task-clean',
    script: 'return 1',
    workflowRunId: 'run-clean',
    setAppState: store.set as never,
  })
  updateWorkflowProgressBatch('wf-task-clean', [agentFrame(1, 'done')], store.set as never)
  const before = (store.state.tasks['wf-task-clean'] as LocalWorkflowTaskState).workflowProgress
  pauseWorkflowTask('wf-task-clean', store.set as never)
  const task = store.state.tasks['wf-task-clean'] as LocalWorkflowTaskState
  check('all-settled children: progress array untouched (same reference)', task.workflowProgress === before)
}

// ── §B the executor skip path: a deliberate settle, never an error frame ────
section('§B operator skip settles the frame as skipped (executor seam)')
{
  const frames: Array<Record<string, unknown>> = []
  const controllers = new Map<string, AbortController>()
  const hangUntilAbort = async (args: {
    toolUseContext?: { abortController?: AbortController }
  }): Promise<never> => {
    await new Promise<void>(resolve => {
      const sig = args.toolUseContext?.abortController?.signal
      if (sig?.aborted) return resolve()
      sig?.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new Error('aborted')
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
        },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-opus-5' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: unknown) => {
      const data = (f as { data?: Record<string, unknown> }).data
      if (data) frames.push(data)
    },
    workflowRunId: undefined,
    onAgentController: (agentId: string, c: AbortController | null) => {
      if (c) controllers.set(agentId, c)
      else controllers.delete(agentId)
    },
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: (async function* (args: never) {
      await hangUntilAbort(args)
    }) as never,
  } as never) as {
    agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>
    getFailures: () => string[]
  }

  const pending = hooks.agent('long job', { stallMs: 60_000 })
  // wait for the attempt to register its controller, then skip it
  while (controllers.size === 0) await new Promise(r => setTimeout(r, 10))
  const [, ctrl] = [...controllers.entries()][0]!
  ctrl.abort('user-skip')
  const res = await pending
  check('skipped agent resolves null (fan-out filter contract)', res === null, String(res))
  const terminal = frames[frames.length - 1]
  check("terminal frame state is 'skipped'", terminal?.state === 'skipped', String(terminal?.state))
  check('the frame still carries the skipped marker + reason', terminal?.skipped === true && terminal?.error === 'skipped by user')
  check(
    'NO error-state frame was emitted for the skip',
    !frames.some(f => f.state === 'error'),
    JSON.stringify(frames.map(f => f.state)),
  )
  check('failures[] excludes the deliberate skip', hooks.getFailures().length === 0, JSON.stringify(hooks.getFailures()))
}

// ── §C the pane grammar: stopped/skipped words are muted, never faults ──────
section('§C pane grammar — muted settle words, no fault tone, no motion claim')
{
  check("agentSnapshotState('stopped') = 'off' (muted, not failed/gated)", agentSnapshotState('stopped') === 'off')
  check("agentSnapshotState('skipped') = 'excluded' (deliberate, not failed)", agentSnapshotState('skipped') === 'excluded')
  const crimson = STATE_STYLE.failed.color
  check(
    'neither settle word borrows the fault colour',
    STATE_STYLE[agentSnapshotState('stopped')].color !== crimson &&
      STATE_STYLE[agentSnapshotState('skipped')].color !== crimson,
  )
  check(
    "phaseTone: stopped residue mutes to 'pending' (no motion/cursor claim)",
    phaseTone({ planned: false, agents: [{ state: 'done' }, { state: 'stopped' }] }) === 'pending',
    phaseTone({ planned: false, agents: [{ state: 'done' }, { state: 'stopped' }] }),
  )
  check(
    "phaseTone: a genuinely in-flight agent still reads 'active'",
    phaseTone({ planned: false, agents: [{ state: 'stopped' }, { state: 'progress' }] }) === 'active',
  )
  check(
    "phaseTone: done + operator-skipped settles the phase",
    phaseTone({ planned: false, agents: [{ state: 'done' }, { state: 'skipped' }] }) === 'settled',
  )
  check(
    'phaseTone: error precedence unchanged',
    phaseTone({ planned: false, agents: [{ state: 'error' }, { state: 'progress' }] }) === 'error',
  )
  check(
    'settledCount: a skip cannot hold its phase open forever',
    settledCount([{ agents: [{ state: 'done' }, { state: 'skipped' }] }]) === 1,
  )
  check(
    'settledCount: stopped does NOT count as settled-done',
    settledCount([{ agents: [{ state: 'done' }, { state: 'stopped' }] }]) === 0,
  )
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} CHILD-SETTLEMENT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CHILD-SETTLEMENT PROOFS PASS')
