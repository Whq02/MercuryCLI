#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-workbench-projection.ts — PROOF: the
//  WorkbenchProjection:
//
//    (1) pure derivation — one root plus three child agents (agent w/
//        worktree, teammate awaiting approval, workflow worker) compose into
//        ONE snapshot with owner-true kinds/phases (teamPhases vocabulary,
//        never invented), OBSERVED changed paths, and lane rows derived from
//        the two live lane sources (agent worktree · context lane); the
//        retired party/zone sources, seat threads and mission rows are
//        pinned ABSENT (the room-consumer retirement) — journey 1's shape.
//    (2) the next-action ladder — blocked thread > handoff-ready lane >
//        handoff-ready teammate > failed thread > run-kernel nextAction >
//        null; deterministic.
//    (3) stable ordering — live threads before terminal, recency within.
//    (4) engine laws — MERCURY_WORKBENCH=0 ⇒ subscribe is a no-op and the
//        one-shot resolve answers null; snapshot reference is STABLE between
//        refreshes (useSyncExternalStore safety).
//    (5) the mercury://workbench adapter resolves through the REAL registry:
//        current ok + children, unknown thread absent, flag-off unavailable —
//        distinct outcomes, named.
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-workbench-projection.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// Hermetic review store — the scoping legs create artifacts.
import { mkdtempSync as _mkdtemp } from 'node:fs'
import { tmpdir as _tmpdir } from 'node:os'
import { join as _join } from 'node:path'
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = _mkdtemp(_join(_tmpdir(), 'mosaic-proj-review-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

import {
  composeWorkbenchSnapshot,
  deriveNextAction,
  type WorkbenchSourceInputs,
} from '../../src/services/workbench/selectors.js'
import { healthOf, sourceReady } from '../../src/substrate/sourceState.js'
import { WORKBENCH_SOURCES_SCHEMA } from '../../src/services/workbench/contracts.js'

function baseInputs(): WorkbenchSourceInputs {
  const now = 1_700_000_000_000
  return {
    now,
    projectRoot: '/repo',
    sessionId: 'sess-1',
    sources: {
      schema: WORKBENCH_SOURCES_SCHEMA,
      artifacts: healthOf(sourceReady(null)),
      contextLanes: healthOf(sourceReady(null)),
      gitWorktrees: healthOf(sourceReady(null)),
    },
    generation: { treeDigest: 'digest-abc', headSha: 'aaaabbbb', branch: 'main', clean: true },
    executions: [
      {
        id: 'task-agent',
        kind: 'agent',
        label: 'refactor the parser',
        state: 'running',
        updatedAt: now - 1000,
        metadata: { taskType: 'local_agent' },
        outputRef: 'mercury://task/task-agent',
      },
      {
        id: 'task-mate',
        kind: 'agent',
        label: 'teammate bob',
        state: 'running',
        updatedAt: now - 2000,
        metadata: { taskType: 'in_process_teammate' },
        outputRef: 'mercury://task/task-mate',
      },
      {
        id: 'task-wf',
        kind: 'workflow-worker',
        label: 'sweep flaky tests',
        state: 'running',
        updatedAt: now - 3000,
        metadata: { taskType: 'local_workflow' },
        outputRef: 'mercury://task/task-wf',
      },
      {
        id: 'task-done',
        kind: 'agent',
        label: 'finished helper',
        state: 'succeeded',
        updatedAt: now - 500,
        metadata: { taskType: 'local_agent' },
      },
    ],
    mainRun: {
      objective: 'ship the feature',
      lifecycle: 'active',
      phase: 'tool-work',
      changedPaths: ['src/a.ts'],
      totalChangedPaths: 1,
      verificationState: 'stale',
      nextAction: 'run the focused prover',
    },
    richTasks: new Map([
      [
        'task-agent',
        {
          id: 'task-agent',
          taskType: 'local_agent',
          description: 'refactor the parser',
          status: 'running',
          agentId: 'agent-1',
          model: 'sonnet-5',
        },
      ],
      [
        'task-mate',
        {
          id: 'task-mate',
          taskType: 'in_process_teammate',
          description: 'teammate bob',
          status: 'running',
          isIdle: false,
          shutdownRequested: false,
          awaitingPlanApproval: true,
          hasProgress: true,
        },
      ],
    ]),
    agentMeta: new Map([
      ['agent-1', { worktreePath: '/wt/agent-1', model: 'sonnet-5', agentType: 'general-purpose' }],
    ]),
    laneRuns: new Map([
      [
        'task-agent',
        { changedPaths: ['src/parser.ts', 'src/lexer.ts'], totalChangedPaths: 2, verificationState: 'verified' },
      ],
    ]),
    contextLanes: [
      {
        id: 'lane-abc',
        goal: 'explore the flaky test',
        status: 'returned',
        childSessionId: 'sess-child',
        handoffPromoted: false,
        handoffReturnedAt: now - 60_000,
      },
    ],
    workflowsDisk: [{ runId: 'wf-9', status: 'running', agentCount: 3 }],
    crew: null,
    artifacts: [],
    gitWorktreeLanes: [],
  }
}

section('(1) pure derivation — one root + three live children, owner-true rows')
{
  const snap = composeWorkbenchSnapshot(baseInputs(), null)
  check('root row derives from the run kernel', snap.root.title === 'ship the feature' && snap.root.phase === 'tool-work')
  check('root carries observed changed paths', snap.root.changedPaths.length === 1 && snap.root.verification === 'stale')
  const terminal = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
  const live = snap.threads.filter(t => !terminal.has(t.state))
  check('three live child threads', live.length === 3, `got ${live.length}`)
  const agent = snap.threads.find(t => t.id === 'task-agent')
  check('agent row: kind agent, model from rich facts', agent?.kind === 'agent' && agent?.model === 'sonnet-5')
  check('agent row: worktree from sidecar meta', agent?.worktreePath === '/wt/agent-1' && agent?.laneId === 'wt:/wt/agent-1')
  check(
    'agent row: OBSERVED changed paths from the lane run',
    agent?.changedPaths.length === 2 && agent?.verification === 'verified',
  )
  const mate = snap.threads.find(t => t.id === 'task-mate')
  check('teammate phase from teamPhases (blocked, not invented)', mate?.kind === 'teammate' && mate?.phase === 'blocked')
  check('teammate blocker surfaces', mate?.blocker === 'awaiting plan approval')
  const wf = snap.threads.find(t => t.id === 'task-wf')
  check('workflow row: kind workflow', wf?.kind === 'workflow')
  // The room-consumer retirement ratchet: no seat thread can derive
  // post-room — a reappearing 'seat' kind is a regression, not a feature.
  check('no seat threads derive post-room (ratchet)', snap.threads.every(t => t.kind !== 'seat'))
  // Lanes: agent worktree + context lane — the two LIVE sources.
  const sources = snap.lanes.map(l => l.source).sort()
  check(
    'two live lane sources derived',
    JSON.stringify(sources) === JSON.stringify(['agent-worktree', 'context-lane']),
    JSON.stringify(sources),
  )
  const ctxLane = snap.lanes.find(l => l.source === 'context-lane')
  check('returned-unpromoted context lane reads handoff-ready', ctxLane?.handoffReady === true)
  check('missions stay empty post-room (ratchet)', snap.missions.length === 0)
  check('generation carries the tree digest', snap.generation.treeDigest === 'digest-abc')
  check('S2 surfaces present and empty', snap.artifactHeads.length === 0 && snap.reviewQueue.length === 0)
}

section('(2) the next-action ladder')
{
  const inputs = baseInputs()
  const snap = composeWorkbenchSnapshot(inputs, null)
  check('blocked thread outranks handoff', snap.nextAction?.startsWith('answer teammate bob') === true, snap.nextAction ?? 'null')

  // Remove the blocker → the handoff-ready lane wins.
  const noBlock = baseInputs()
  noBlock.richTasks.get('task-mate')!.awaitingPlanApproval = false
  const snap2 = composeWorkbenchSnapshot(noBlock, null)
  check('handoff-ready lane next', snap2.nextAction?.startsWith('adopt lane lane-abc') === true, snap2.nextAction ?? 'null')

  // Remove the lane too → kernel nextAction.
  const noLane = baseInputs()
  noLane.richTasks.get('task-mate')!.awaitingPlanApproval = false
  noLane.contextLanes = []
  const snap3 = composeWorkbenchSnapshot(noLane, null)
  check('falls through to the run-kernel nextAction', snap3.nextAction === 'run the focused prover', snap3.nextAction ?? 'null')

  // Failed thread outranks kernel suggestion.
  const failed = baseInputs()
  failed.richTasks.get('task-mate')!.awaitingPlanApproval = false
  failed.contextLanes = []
  failed.executions[0]!.state = 'failed'
  const snap4 = composeWorkbenchSnapshot(failed, null)
  check('failed thread inspection next', snap4.nextAction?.startsWith('inspect failure') === true, snap4.nextAction ?? 'null')

  // Nothing actionable → null.
  const quiet = baseInputs()
  quiet.richTasks.get('task-mate')!.awaitingPlanApproval = false
  quiet.contextLanes = []
  quiet.mainRun = { objective: 'x', lifecycle: 'active', phase: 'idle' }
  const snap5 = composeWorkbenchSnapshot(quiet, null)
  check('quiet workbench has null next action', snap5.nextAction === null, String(snap5.nextAction))

  // Ladder helper directly: review queue outranks everything.
  const action = deriveNextAction({
    reviewQueue: [{ ref: 'mercury://artifact/x', note: 'plan v2 awaiting review' }],
    root: snap.root,
    threads: snap.threads,
    lanes: snap.lanes,
    mainRun: inputs.mainRun,
  })
  check('review queue outranks blockers', action === 'review: plan v2 awaiting review', action ?? 'null')
}

section('(3) ordering + version monotonicity')
{
  const snap = composeWorkbenchSnapshot(baseInputs(), null)
  const terminalIdx = snap.threads.findIndex(t => t.id === 'task-done')
  const lastLiveIdx = snap.threads.reduce((acc, t, i) => (t.state === 'running' ? i : acc), -1)
  check('terminal thread sorts after live threads', terminalIdx > lastLiveIdx)
  const snap2 = composeWorkbenchSnapshot(baseInputs(), snap)
  check('version is monotonic across recomposition', snap2.version === snap.version + 1)
}

section('(4) engine laws — flag gate + stable reference')
{
  const prev = process.env.MERCURY_WORKBENCH
  process.env.MERCURY_WORKBENCH = '0'
  const { resolveWorkbenchSnapshot, subscribeWorkbench, getWorkbenchSnapshot, _resetWorkbenchForTesting } =
    await import('../../src/services/workbench/projection.js')
  _resetWorkbenchForTesting()
  const offSnap = await resolveWorkbenchSnapshot()
  check('flag off ⇒ one-shot resolve answers null', offSnap === null)
  let notified = false
  const unsub = subscribeWorkbench(() => {
    notified = true
  })
  await new Promise(r => setTimeout(r, 50))
  check('flag off ⇒ subscribe is a no-op (no engine, no notify)', notified === false && getWorkbenchSnapshot() === null)
  unsub()

  if (prev === undefined) delete process.env.MERCURY_WORKBENCH
  else process.env.MERCURY_WORKBENCH = prev

  // Live one-shot in this repo: composes without a state provider (degraded
  // enumeration is honest — no rich tasks, but a real generation + root).
  const live = await resolveWorkbenchSnapshot()
  check('live one-shot composes', live !== null && typeof live.version === 'number')
  check('live one-shot names this project root', live !== null && live.projectRoot.length > 0)
  // Stable reference law: no engine subscriber, repeated getter reads agree.
  const a = getWorkbenchSnapshot()
  const b = getWorkbenchSnapshot()
  check('getter returns a stable reference between refreshes', a === b)

  // Verify-wave regressions (UI findings 3/P3-14):
  const { createReviewArtifact } = await import('../../src/utils/artifacts/reviewStore.js')
  createReviewArtifact({
    kind: 'plan', title: 'here', producer: { sessionId: 's' },
    workspace: { roots: [process.cwd()] }, body: { kind: 'plan', markdown: 'x\n' },
    initialStatus: 'ready-for-review',
  })
  createReviewArtifact({
    kind: 'plan', title: 'elsewhere', producer: { sessionId: 's' },
    workspace: { roots: ['/definitely/other/project'] }, body: { kind: 'plan', markdown: 'x\n' },
    initialStatus: 'ready-for-review',
  })
  const scoped = await resolveWorkbenchSnapshot()
  check(
    "another project's artifacts never enter THIS workbench",
    scoped !== null &&
      scoped.artifactHeads.some(h => h.title === 'here') &&
      !scoped.artifactHeads.some(h => h.title === 'elsewhere'),
  )
  const again = await resolveWorkbenchSnapshot()
  check('one-shot resolves advance the version (stamp honesty)', again !== null && scoped !== null && again.version > scoped.version)
}

section('(5) the mercury://workbench adapter through the REAL registry')
{
  const { resolveResource } = await import('../../src/services/resources/registry.js')
  await import('../../src/services/resources/adapters/workbench.js')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.js')
  const ctx = { owner: processMainOwner(), cwd: process.cwd() }

  const current = await resolveResource('mercury://workbench/current', ctx)
  check('current resolves ok', current.state === 'ok', current.state !== 'ok' ? current.note : '')
  if (current.state === 'ok') {
    check('current is versioned + structured', typeof current.resource.version === 'string' && current.resource.structured !== undefined)
    check('current text is bounded with a page', typeof current.resource.text === 'string' && current.resource.page !== undefined)
  }

  const rootThread = await resolveResource('mercury://workbench/thread/root', ctx)
  check('thread/root resolves ok', rootThread.state === 'ok', rootThread.state !== 'ok' ? rootThread.note : '')

  const missing = await resolveResource('mercury://workbench/thread/nope-xyz', ctx)
  check('unknown thread is absent (not unavailable)', missing.state === 'absent', missing.state)

  const badForm = await resolveResource('mercury://workbench/bogus/1', ctx)
  check('unknown form is absent with teaching note', badForm.state === 'absent' && badForm.note.includes('forms'))

  process.env.MERCURY_WORKBENCH = '0'
  const off = await resolveResource('mercury://workbench/current', ctx)
  check('flag off ⇒ adapter answers unavailable naming the flag', off.state === 'unavailable' && off.note.includes('MERCURY_WORKBENCH=0'))
  delete process.env.MERCURY_WORKBENCH

  const { resourceAdapterKinds } = await import('../../src/services/resources/registry.js')
  check(
    'workbench kind is in the runtime census',
    resourceAdapterKinds().some(k => k.kind === 'workbench'),
  )
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ workbench projection proofs green')
