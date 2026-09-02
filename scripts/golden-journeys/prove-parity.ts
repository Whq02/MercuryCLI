// ============================================================================
//  scripts/golden-journeys/prove-parity.ts — terminal ↔ editor fact parity
//
//
//  The divergence matrix: the SAME seeded substantial world is read two
//  ways — (a) the EDITOR-SIDE path (reconcileOnResume + gatherCurrentWork,
//  exactly what mercury://workbench/work serves ACP) and (b) the TERMINAL
//  surfaces that own each fact today: the resumed frame (glance), the
//  prompts panel's receipt roll (/workbench), and the diff review (/diff).
//  A fact whose owning terminal surface drops it, or whose editor projection
//  drops it, is RED.
//
// Four facts lost their terminal owner when the WORK lane retired (with
//  the unified resume: the rail's WORK digest never paints on a
//  resumed frame, /run answers only the process-main owner, and the task
//  board reads the process session — both blind to the focused chat):
//  remains · blocked · proposed-next · evidence. Those rows stay pinned on
//  the EDITOR projection so it cannot rot while the terminal side is
//  rebuilt; restoring a terminal owner for them is the lead-queued follow-up
//  named in the retirement report.
// ============================================================================

import {
  SIDS,
  FIXTURE_CWD,
  RUN_HOME,
  capture,
  cleanupWorld,
  hasProse,
  makeChecker,
  requireDist,
  seedWorld,
  slashSends,
} from './journeyLib.ts'
import { J3_ITEMS, J3_NEXT_ACTION, J3_OBJECTIVE, seedSubstantialState } from './j3State.ts'

requireDist()
const { check, failures } = makeChecker()
console.log('prove-parity — the M5 terminal↔editor fact matrix')

seedWorld()
const sid = SIDS.J3
seedSubstantialState(sid)

// The bun-side reads resolve against the seeded world exactly the way an
// in-product ACP consumer would: the world's config home + the transcript's
// session as the task-list id.
process.env.MERCURY_CONFIG_DIR = RUN_HOME
process.chdir(FIXTURE_CWD)
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { reconcileOnResume, getRunSnapshot } = await import(
  '../../src/services/run/runCoordinator.ts'
)
const owner = makeOwnerKey({ workspace: FIXTURE_CWD, sessionId: sid, lane: 'main' })

// ── phase 0: the MISMATCHED-CONTEXT law (found BY this matrix) — a reconcile
// whose task-list id resolves elsewhere (no session, epoch 0, empty read)
// must NOT drop the recorded plan and flush the damage. ────────────────────
{
  const rec0 = await reconcileOnResume(owner, FIXTURE_CWD)
  check('mismatched-context reconcile still loads the world', rec0.state === 'reconciled')
  const k0 = getRunSnapshot(owner)
  check(
    'an epoch-0 empty ledger read never drops open deliverables',
    (k0?.deliverables.filter(d => d.state === 'open' || d.state === 'in-progress').length ?? 0) >= 3,
    JSON.stringify(k0?.deliverables.map(d => [d.id, d.state])),
  )
}

// ── (a) the editor-side read: the faithful in-session context ───────────────
const rec = await reconcileOnResume(owner, FIXTURE_CWD)
check('editor-side reconcile loads the world', rec.state === 'reconciled')
const kernel = getRunSnapshot(owner)

const { deriveCurrentWork } = await import('../../src/services/workbench/currentWork.ts')
const work = deriveCurrentWork({
  now: Date.now(),
  owner,
  workspace: FIXTURE_CWD,
  run: kernel,
  tasks: J3_ITEMS.map(t => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    blockedBy: 'blockedBy' in t ? (t.blockedBy as string[]) : [],
  })),
  workbench: null, // the editor degrades honestly without AppState — run facts stand
  model: 'claude-fable-5',
  effortLabel: 'high',
  contextPct: null,
  executionShape: null,
  recovery: { state: 'live' },
})

// ── (b) the terminal read: the surfaces that own each fact today ────────────
const frame = capture({ sid, tag: 'parity-glance' })
const panel = capture({ sid, tag: 'parity-panel', sends: slashSends('/workbench'), total: 110 })
const diff = capture({ sid, tag: 'parity-diff', sends: slashSends('/diff'), total: 110 })

// ── the fact matrix: facts WITH a terminal owner agree on both sides ────────
const matrix: Array<[string, string | null, boolean, string]> = [
  ['outcome', work.outcome, hasProse(panel, 'Modernize the fixture demo end to end'), 'the panel receipt roll'],
  ['doing-now', work.activeItem?.title ?? null, hasProse(frame, 'wiring the config loader'), 'the resumed frame'],
  ['changed', work.changedPaths[0] ?? null, hasProse(diff, 'greet.ts'), 'the diff review'],
]
for (const [fact, editorValue, terminalVisible, surface] of matrix) {
  check(
    `${fact}: the editor projection carries the fact ${surface} shows`,
    editorValue !== null && terminalVisible,
    `editor=${JSON.stringify(editorValue)} terminal=${terminalVisible}`,
  )
}

// ── facts whose terminal owner retired with the WORK lane: the editor
//    projection still carries every one (the rot guard while the terminal
//    side is rebuilt) ────────────────────────────────────────────────────────
const editorOnly: Array<[string, string | null]> = [
  ['remains', work.planItems.find(i => i.state === 'open')?.title ?? null],
  ['blocked', work.blockedItems[0]?.title ?? null],
  ['proposed-next', work.nextAction],
  ['evidence', work.verification?.state ?? null],
]
for (const [fact, editorValue] of editorOnly) {
  check(
    `${fact}: the editor projection carries the fact (terminal owner retired with the WORK lane — lead-queued)`,
    editorValue !== null,
    `editor=${JSON.stringify(editorValue)}`,
  )
}
check('editor outcome text is the seeded objective, verbatim', work.outcome === J3_OBJECTIVE)
check(
  'editor next action is the seeded next action',
  (work.nextAction ?? '').startsWith(J3_NEXT_ACTION.slice(0, 20)),
  work.nextAction ?? '(null)',
)
check('scale agrees (substantial)', work.scale === 'substantial')
check('identity is the durable run', work.identity.runId === kernel?.runId && work.identity.runId !== null)

// ── M6 review-wave laws (friction findings 3b/3c/3d + logic finding B) ──────

// 3b · the clobber guard: a run created DURING the reconcile's await owns the
// owner — the disk state must never replace it.
{
  const { acceptUserRequest } = await import('../../src/services/run/runCoordinator.ts')
  const { makeOwnerKey: mk } = await import('../../src/services/run/ownerKey.ts')
  const raceOwner = mk({ workspace: FIXTURE_CWD, sessionId: SIDS.J4, lane: 'main' })
  seedSubstantialState(SIDS.J4)
  const racePromise = reconcileOnResume(raceOwner, FIXTURE_CWD) // load in flight…
  const fresh = acceptUserRequest(raceOwner, { objective: 'a brand new ask', rootMessageId: null })
  const raceResult = await racePromise
  check('3b: a mid-reconcile prompt wins (reconcile stands down)', raceResult.state === 'none')
  check('3b: the fresh run survives untouched', getRunSnapshot(raceOwner)?.runId === fresh.runId)
}

// 3c · a BLOCKED run resumes blocked (the unanswered operator blocker
// survives a mere app reopen).
{
  const { foldRun, writeRunSidecar } = await import('./journeyLib.ts')
  const blockedSid = SIDS.J1
  const t0 = Date.parse('2026-07-20T12:00:00.000Z')
  writeRunSidecar(
    blockedSid,
    foldRun(blockedSid, 'run_parity_blocked', 'Ship the gated feature', [
      { type: 'substantive', at: t0 + 1000, reason: 'invoked Edit' },
      {
        type: 'blocked',
        at: t0 + 2000,
        blocker: {
          description: 'needs the API contract decision',
          ownedBy: 'operator',
          resumeCondition: 'operator answers the contract question',
          at: t0 + 2000,
        },
      },
    ]),
  )
  const { makeOwnerKey: mk } = await import('../../src/services/run/ownerKey.ts')
  const blockedOwner = mk({ workspace: FIXTURE_CWD, sessionId: blockedSid, lane: 'main' })
  const recB = await reconcileOnResume(blockedOwner, FIXTURE_CWD)
  check('3c: a blocked run reconciles (not terminal)', recB.state === 'reconciled')
  const kb = getRunSnapshot(blockedOwner)
  check('3c: the unanswered operator blocker SURVIVES the resume', kb?.lifecycle === 'blocked' && kb.blocker?.description === 'needs the API contract decision')

  // 3d (F9) · pickRunFacts renders the OBJECT blocker — the pre-fix
  // typeof-string check could never fire, so the workbench root row never
  // showed the kernel blocker. Pinned through the real projection helper.
  const { pickRunFacts } = await import('../../src/services/workbench/projection.ts')
  const runFactsB = pickRunFacts(kb)
  check('3d: workbench run facts carry the object blocker', runFactsB?.blocker === 'operator: needs the API contract decision')
}

// 3a · stale ready-for-review artifacts stop pinning the next action.
{
  const { composeWorkbenchSnapshot } = await import('../../src/services/workbench/selectors.ts')
  const { WORKBENCH_SOURCES_SCHEMA } = await import('../../src/services/workbench/contracts.ts')
  const { healthOf, sourceReady } = await import('../../src/substrate/sourceState.ts')
  const base = {
    now: Date.now(),
    projectRoot: FIXTURE_CWD,
    sessionId: SIDS.J3,
    executions: [],
    mainRun: null,
    richTasks: new Map(),
    agentMeta: new Map(),
    laneRuns: new Map(),
    contextLanes: [],
    partySeats: null,
    collab: null,
    workflowsDisk: [],
    crew: [],
    gitWorktreeLanes: [],
    // Required on WorkbenchSourceInputs. The `as never`
    // casts below dodge the compile-time ratchet, so this fixture has to
    // carry it by hand or compose would emit a snapshot whose `sources` is
    // undefined — malformed in a way nothing here would notice.
    sources: {
      schema: WORKBENCH_SOURCES_SCHEMA,
      artifacts: healthOf(sourceReady(null)),
      contextLanes: healthOf(sourceReady(null)),
      gitWorktrees: healthOf(sourceReady(null)),
    },
  }
  const artifact = {
    id: 'wt1',
    kind: 'walkthrough',
    title: 'yesterday',
    latestVersion: 1,
    status: 'ready-for-review',
    treeDigest: 'digest-OLD',
    openComments: 0,
    updatedAt: Date.now(),
  }
  const staleSnap = composeWorkbenchSnapshot(
    { ...base, generation: { treeDigest: 'digest-NEW' }, artifacts: [artifact] } as never,
    null,
  )
  check('3a: a STALE awaits-review artifact leaves the queue', staleSnap.reviewQueue.length === 0)
  check('3a: …and stops pinning the next action', staleSnap.nextAction === null)
  check('3a: the head still lists it, marked stale', staleSnap.artifactHeads[0]?.stale === true)
  const freshSnap = composeWorkbenchSnapshot(
    { ...base, generation: { treeDigest: 'digest-OLD' }, artifacts: [artifact] } as never,
    null,
  )
  check('3a: a CURRENT-tree artifact still queues for review', freshSnap.reviewQueue.length === 1)
}

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nprove-parity: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nprove-parity: green')
