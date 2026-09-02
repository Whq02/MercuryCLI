// ============================================================================
//  scripts/golden-journeys/prove-current-work.ts — the CurrentWork projection laws
//
//
//  Drives the PURE derivation directly (the workbench-selectors proof shape):
//  honest distinct states (unavailable ≠ empty), observed-shape scale, no
//  invented next action, dependency-blocked items only under a live ledger,
//  stable identity across restart shapes, determinism.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import {
  deriveCurrentWork,
  type CurrentWorkInputs,
} from '../../src/services/workbench/currentWork.ts'
import {
  emptyRunSnapshot,
  reduceRunEvent,
  type RunEvent,
  type RunSnapshot,
} from '../../src/services/run/runKernel.ts'
import { makeOwnerKey } from '../../src/services/run/ownerKey.ts'
import {
  WORKBENCH_SOURCES_SCHEMA,
  type WorkbenchSnapshot,
} from '../../src/services/workbench/contracts.ts'
import {
  healthOf,
  sourceReady,
  sourceUnavailable,
} from '../../src/substrate/sourceState.ts'

/** A source that was read cleanly — built through the real vocabulary so this
 *  fixture cannot drift from the shape production emits. */
const readOk = () => healthOf(sourceReady(null))

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const OWNER = makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: 'main' })
const T0 = 1_700_000_000_000

function run(events: RunEvent[], objective = 'ship the widget'): RunSnapshot {
  let snap = emptyRunSnapshot({ runId: 'r1', owner: OWNER, objective, rootMessageId: null, at: T0 })
  for (const e of events) snap = reduceRunEvent(snap, e)
  return snap
}

function inputs(over: Partial<CurrentWorkInputs>): CurrentWorkInputs {
  return {
    now: T0 + 60_000,
    owner: OWNER,
    workspace: '/w',
    run: null,
    tasks: null,
    workbench: null,
    model: 'claude-fable-5',
    effortLabel: 'high',
    contextPct: 12,
    executionShape: null,
    recovery: { state: 'none' },
    ...over,
  }
}

function wb(over: Partial<WorkbenchSnapshot>): WorkbenchSnapshot {
  return {
    version: 1,
    refreshedAt: T0,
    projectRoot: '/w',
    generation: { treeDigest: 'digest-live' },
    root: {
      id: 'root',
      kind: 'root',
      title: 'session',
      phase: 'implementation',
      state: 'running',
      updatedAt: T0,
      changedPaths: [],
      refs: [],
    },
    threads: [],
    lanes: [],
    missions: [],
    artifactHeads: [],
    reviewQueue: [],
    nextAction: null,
    sources: {
      schema: WORKBENCH_SOURCES_SCHEMA,
      artifacts: readOk(),
      contextLanes: readOk(),
      gitWorktrees: readOk(),
    },
    ...over,
  }
}

console.log('prove-current-work — the M1 projection laws')

// ── 1 · no run ⇒ scale none, nothing invented ───────────────────────────────
{
  const w = deriveCurrentWork(inputs({}))
  check('no run ⇒ scale none', w.scale === 'none')
  check('no run ⇒ outcome null (never invented)', w.outcome === null)
  check('no run ⇒ nextAction null (never invented)', w.nextAction === null)
  check('no run ⇒ verification null (absent ≠ unverified)', w.verification === null)
  check('workbench unavailable ⇒ agents null (≠ zero)', w.agents === null)
  check('workbench unavailable ⇒ review null (≠ empty)', w.review === null)
  check('ledger unavailable is DISTINCT from empty', w.ledger === 'unavailable')
}

// ── 2 · pure Q&A stays lightweight ──────────────────────────────────────────
{
  const w = deriveCurrentWork(inputs({ run: run([]) }))
  check('non-substantive run ⇒ scale none (Q&A stays light)', w.scale === 'none')
  check('…but the outcome is still the truthful objective', w.outcome === 'ship the widget')
}

// ── 3 · observed-shape scale ────────────────────────────────────────────────
{
  const direct = run([
    { type: 'substantive', at: T0 + 1, reason: 'invoked Edit' },
    { type: 'task-transition', at: T0 + 2, taskId: '1', title: 'one', state: 'in-progress' },
  ])
  const substantial = run([
    { type: 'substantive', at: T0 + 1, reason: 'invoked Edit' },
    { type: 'task-transition', at: T0 + 2, taskId: '1', title: 'one', state: 'done' },
    { type: 'task-transition', at: T0 + 3, taskId: '2', title: 'two', state: 'open' },
  ])
  check('substantive + ≤1 item ⇒ direct', deriveCurrentWork(inputs({ run: direct })).scale === 'direct')
  check('substantive + ≥2 items ⇒ substantial', deriveCurrentWork(inputs({ run: substantial })).scale === 'substantial')
  const w = deriveCurrentWork(inputs({ run: substantial }))
  check('completedCount counts done items only', w.completedCount === 1)
  check('activeItem is null when nothing is in progress (never guessed)', w.activeItem === null)
}

// ── 4 · dependency-blocked items need a LIVE ledger + an OPEN edge ──────────
{
  const snap = run([
    { type: 'substantive', at: T0 + 1, reason: 'work' },
    { type: 'task-transition', at: T0 + 2, taskId: '4', title: 'docs', state: 'open' },
    { type: 'task-transition', at: T0 + 3, taskId: '5', title: 'notes', state: 'open' },
  ])
  const tasks = [
    { id: '4', subject: 'docs', status: 'pending', blockedBy: [] },
    { id: '5', subject: 'notes', status: 'pending', blockedBy: ['4'] },
  ]
  const w = deriveCurrentWork(inputs({ run: snap, tasks }))
  check('open blockedBy on an open blocker ⇒ blocked item', w.blockedItems.length === 1 && w.blockedItems[0]!.id === '5')
  const cleared = deriveCurrentWork(
    inputs({
      run: snap,
      tasks: [
        { id: '4', subject: 'docs', status: 'completed', blockedBy: [] },
        { id: '5', subject: 'notes', status: 'pending', blockedBy: ['4'] },
      ],
    }),
  )
  check('a COMPLETED blocker clears the edge', cleared.blockedItems.length === 0)
  const noLedger = deriveCurrentWork(inputs({ run: snap, tasks: null }))
  check('ledger unavailable ⇒ blocked items UNKNOWN (empty, flagged)', noLedger.blockedItems.length === 0 && noLedger.ledger === 'unavailable')
}

// ── 5 · the ONE next action prefers the workbench derivation ────────────────
{
  const snap = run([
    { type: 'substantive', at: T0 + 1, reason: 'work' },
    { type: 'next-action', at: T0 + 2, action: 'kernel says: continue item 1' },
  ])
  const withWb = deriveCurrentWork(
    inputs({ run: snap, workbench: wb({ nextAction: 'review: the widget diff' }) }),
  )
  check('workbench next action wins (it folds review + blocked threads)', withWb.nextAction === 'review: the widget diff')
  const noWb = deriveCurrentWork(inputs({ run: snap }))
  check('kernel next action is the fallback', noWb.nextAction === 'kernel says: continue item 1')
}

// ── 6 · review facts derive from artifact heads, staleness included ─────────
{
  const w = deriveCurrentWork(
    inputs({
      workbench: wb({
        artifactHeads: [
          { ref: 'mercury://artifact/a1', kind: 'walkthrough', title: 'W', status: 'ready-for-review', stale: true },
        ],
        reviewQueue: [{ ref: 'mercury://artifact/a1', note: 'W v1 awaits review' }],
      }),
    }),
  )
  check('review counts derive from the real heads', w.review !== null && w.review.openArtifacts === 1 && w.review.awaitingReview === 1)
  check('stale artifacts surface as stale', w.review !== null && w.review.anyStale === true)
  check('artifact refs pass through as refs (deep-link, never clone)', w.artifactRefs[0] === 'mercury://artifact/a1')
}

// ── 6b · an UNREADABLE artifact source is UNKNOWN, never "0" ───
// The live workbench is present and its OTHER sources read fine; only the
// artifact store could not be enumerated. Reporting openArtifacts: 0 here is
// the confident false statement defect H is made of — `review`'s own law
// already said null means "store unreadable", and this is that case.
{
  const blind = deriveCurrentWork(
    inputs({
      workbench: wb({
        artifactHeads: [],
        reviewQueue: [],
        sources: {
          schema: WORKBENCH_SOURCES_SCHEMA,
          artifacts: healthOf(sourceUnavailable('ENOTDIR: store root is a file')),
          contextLanes: readOk(),
          gitWorktrees: readOk(),
        },
      }),
    }),
  )
  check(
    'artifact source unavailable ⇒ review UNKNOWN (null), never 0 open artifacts',
    blind.review === null,
    JSON.stringify(blind.review),
  )
  const observed = deriveCurrentWork(inputs({ workbench: wb({}) }))
  check(
    'a source that READ and held nothing still reports a real zero',
    observed.review !== null && observed.review.openArtifacts === 0,
    JSON.stringify(observed.review),
  )
}

// ── 7 · identity is stable across restart shapes ────────────────────────────
{
  const live = deriveCurrentWork(inputs({ run: run([{ type: 'substantive', at: T0 + 1, reason: 'w' }]) }))
  check('live identity carries the runId', live.identity.runId === 'r1')
  const unrec = deriveCurrentWork(inputs({ recovery: { state: 'unreconciled', runId: 'r1' } }))
  check('an UNRECONCILED sidecar still names the same runId (F1 made visible)', unrec.identity.runId === 'r1')
  const receipt = deriveCurrentWork(inputs({ recovery: { state: 'terminal-receipt', runId: 'r1' } }))
  check('a terminal receipt keeps the identity without reactivation', receipt.identity.runId === 'r1' && receipt.scale === 'none')
}

// ── 7b · execution shape passes through only for real work ──────────────────
{
  const shape = { profile: 'solo-default', source: 'measured-selector', reasonCodes: ['no-route-plan'] }
  const idle = deriveCurrentWork(inputs({ executionShape: shape }))
  check('execution shape is DROPPED when scale is none (no invented plans)', idle.executionShape === null)
  const working = deriveCurrentWork(
    inputs({ run: run([{ type: 'substantive', at: T0 + 1, reason: 'w' }]), executionShape: shape }),
  )
  check('execution shape passes through for substantive work', working.executionShape?.profile === 'solo-default')
}

// ── 8 · determinism ─────────────────────────────────────────────────────────
{
  const i = inputs({ run: run([{ type: 'substantive', at: T0 + 1, reason: 'w' }]) })
  check('identical inputs ⇒ deep-equal output', JSON.stringify(deriveCurrentWork(i)) === JSON.stringify(deriveCurrentWork(i)))
}

if (failures > 0) {
  console.error(`\nprove-current-work: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-current-work: green')
