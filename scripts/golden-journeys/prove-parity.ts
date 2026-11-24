
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

process.env.MERCURY_CONFIG_DIR = RUN_HOME
seedWorld()
const sid = SIDS.J3
seedSubstantialState(sid)
process.chdir(FIXTURE_CWD)
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
setOriginalCwd(FIXTURE_CWD)
setProjectRoot(FIXTURE_CWD)
setCwdState(FIXTURE_CWD)
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const { reconcileOnResume, getRunSnapshot } = await import(
  '../../src/engine/run/runCoordinator.ts'
)
const owner = makeOwnerKey({ workspace: FIXTURE_CWD, sessionId: sid, lane: 'main' })

{
  const rec0 = await reconcileOnResume(owner, FIXTURE_CWD)
  check('mismatched-context reconcile still loads the world', rec0.state === 'reconciled', `state=${rec0.state}; reconcileOnResume in src/engine/run/runCoordinator.ts must reconcile the seeded J3 run`)
  const k0 = getRunSnapshot(owner)
  check(
    'an epoch-0 empty ledger read never drops open deliverables',
    (k0?.deliverables.filter(d => d.state === 'open' || d.state === 'in-progress').length ?? 0) >= 3,
    `${JSON.stringify(k0?.deliverables.map(d => [d.id, d.state]))}; reconcileOnResume in src/engine/run/runCoordinator.ts must keep at least three open or in-progress deliverables`,
  )
}

const rec = await reconcileOnResume(owner, FIXTURE_CWD)
check('editor-side reconcile loads the world', rec.state === 'reconciled', `state=${rec.state}; reconcileOnResume in src/engine/run/runCoordinator.ts must reconcile the seeded J3 run`)
const kernel = getRunSnapshot(owner)

const { deriveCurrentWork } = await import('../../src/screen/workbench/currentWork.ts')
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
  workbench: null,
  model: 'claude-fable-5',
  effortLabel: 'high',
  contextPct: null,
  recovery: { state: 'live' },
})

const frame = capture({ sid, tag: 'parity-glance' })
const panel = capture({ sid, tag: 'parity-panel', sends: slashSends('/workbench'), total: 110 })
const diff = capture({ sid, tag: 'parity-diff', sends: slashSends('/diff'), total: 110 })

const matrix: Array<[string, string | null, boolean, string]> = [
  ['outcome', work.outcome, hasProse(panel, 'Modernize the fixture demo end to end'), 'the panel receipt roll'],
  ['doing-now', work.activeItem?.title ?? null, hasProse(frame, 'wiring the config loader'), 'the resumed frame'],
  ['changed', work.changedPaths[0] ?? null, hasProse(diff, 'greet.ts'), 'the diff review'],
]
for (const [fact, editorValue, terminalVisible, surface] of matrix) {
  check(
    `${fact}: the editor projection carries the fact ${surface} shows`,
    editorValue !== null && terminalVisible,
    `editor=${JSON.stringify(editorValue)} terminal=${terminalVisible}; the editor side comes from deriveCurrentWork in src/screen/workbench/currentWork.ts, the terminal side is the capture named parity-glance, parity-panel or parity-diff`,
  )
}

const editorOnly: Array<[string, string | null]> = [
  ['remains', work.planItems.find(i => i.state === 'open')?.title ?? null],
  ['blocked', work.blockedItems[0]?.title ?? null],
  ['proposed-next', work.nextAction],
  ['evidence', work.verification?.state ?? null],
]
for (const [fact, editorValue] of editorOnly) {
  check(
    `${fact}: the editor projection carries the fact (its one owner since the WORK lane retired)`,
    editorValue !== null,
    `editor=${JSON.stringify(editorValue)}; deriveCurrentWork in src/screen/workbench/currentWork.ts must return this fact for the seeded J3 state`,
  )
}
check('editor outcome text is the seeded objective, verbatim', work.outcome === J3_OBJECTIVE, `outcome=${JSON.stringify(work.outcome)}; deriveCurrentWork in src/screen/workbench/currentWork.ts must return J3_OBJECTIVE from scripts/golden-journeys/j3State.ts unchanged`)
check(
  'editor next action is the seeded next action',
  (work.nextAction ?? '').startsWith(J3_NEXT_ACTION.slice(0, 20)),
  `${work.nextAction ?? '(null)'}; deriveCurrentWork in src/screen/workbench/currentWork.ts must return J3_NEXT_ACTION from scripts/golden-journeys/j3State.ts`,
)
check('scale agrees (substantial)', work.scale === 'substantial', `scale=${work.scale}; deriveCurrentWork in src/screen/workbench/currentWork.ts must grade the five-item J3 state as substantial`)
check('identity is the durable run', work.identity.runId === kernel?.runId && work.identity.runId !== null, `editor runId=${work.identity.runId} run snapshot runId=${kernel?.runId}; deriveCurrentWork in src/screen/workbench/currentWork.ts must take identity.runId from the run snapshot`)


{
  const { acceptUserRequest } = await import('../../src/engine/run/runCoordinator.ts')
  const { makeOwnerKey: mk } = await import('../../src/engine/run-owner/ownerKey.ts')
  const raceOwner = mk({ workspace: FIXTURE_CWD, sessionId: SIDS.J4, lane: 'main' })
  seedSubstantialState(SIDS.J4)
  const racePromise = reconcileOnResume(raceOwner, FIXTURE_CWD)
  const fresh = acceptUserRequest(raceOwner, { objective: 'a brand new ask', rootMessageId: null })
  const raceResult = await racePromise
  check('3b: a mid-reconcile prompt wins (reconcile stands down)', raceResult.state === 'none', `state=${raceResult.state}; reconcileOnResume in src/engine/run/runCoordinator.ts must stand down when acceptUserRequest lands during the reconcile`)
  check('3b: the fresh run survives untouched', getRunSnapshot(raceOwner)?.runId === fresh.runId, `snapshot runId=${getRunSnapshot(raceOwner)?.runId} fresh runId=${fresh.runId}; reconcileOnResume in src/engine/run/runCoordinator.ts must not overwrite the run acceptUserRequest created`)
}

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
  const { makeOwnerKey: mk } = await import('../../src/engine/run-owner/ownerKey.ts')
  const blockedOwner = mk({ workspace: FIXTURE_CWD, sessionId: blockedSid, lane: 'main' })
  const recB = await reconcileOnResume(blockedOwner, FIXTURE_CWD)
  check('3c: a blocked run reconciles (not terminal)', recB.state === 'reconciled', `state=${recB.state}; reconcileOnResume in src/engine/run/runCoordinator.ts must reconcile a blocked run rather than treat it as terminal`)
  const kb = getRunSnapshot(blockedOwner)
  check('3c: the unanswered operator blocker SURVIVES the resume', kb?.lifecycle === 'blocked' && kb.blocker?.description === 'needs the API contract decision', `lifecycle=${kb?.lifecycle} blocker=${JSON.stringify(kb?.blocker)}; reconcileOnResume in src/engine/run/runCoordinator.ts must keep an unanswered operator blocker`)

  const { pickRunFacts } = await import('../../src/screen/workbench/projection.ts')
  const runFactsB = pickRunFacts(kb)
  check('3d: workbench run facts carry the object blocker', runFactsB?.blocker === 'operator: needs the API contract decision', `blocker=${JSON.stringify(runFactsB?.blocker)}; pickRunFacts in src/screen/workbench/projection.ts must render the blocker as owner: description`)
}

{
  const { composeWorkbenchSnapshot } = await import('../../src/screen/workbench/selectors.ts')
  const { WORKBENCH_SOURCES_SCHEMA } = await import('../../src/screen/workbench/contracts.ts')
  const { healthOf, sourceReady } = await import('../../src/platform/substrate/sourceState.ts')
  const base = {
    now: Date.now(),
    projectRoot: FIXTURE_CWD,
    sessionId: SIDS.J3,
    executions: [],
    mainRun: null,
    richTasks: new Map(),
    crewmateMeta: new Map(),
    laneRuns: new Map(),
    partySeats: null,
    collab: null,
    crew: [],
    gitWorktreeLanes: [],
    sources: {
      schema: WORKBENCH_SOURCES_SCHEMA,
      artifacts: healthOf(sourceReady(null)),
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
  check('3a: a STALE awaits-review artifact leaves the queue', staleSnap.reviewQueue.length === 0, `reviewQueue length=${staleSnap.reviewQueue.length}; composeWorkbenchSnapshot in src/screen/workbench/selectors.ts must drop an artifact whose treeDigest differs from the generation digest`)
  check('3a: …and stops pinning the next action', staleSnap.nextAction === null, `nextAction=${JSON.stringify(staleSnap.nextAction)}; composeWorkbenchSnapshot in src/screen/workbench/selectors.ts must not pin the next action on a stale artifact`)
  check('3a: the head still lists it, marked stale', staleSnap.artifactHeads[0]?.stale === true, `stale=${staleSnap.artifactHeads[0]?.stale}; composeWorkbenchSnapshot in src/screen/workbench/selectors.ts must still list a stale artifact head marked stale`)
  const freshSnap = composeWorkbenchSnapshot(
    { ...base, generation: { treeDigest: 'digest-OLD' }, artifacts: [artifact] } as never,
    null,
  )
  check('3a: a CURRENT-tree artifact still queues for review', freshSnap.reviewQueue.length === 1, `reviewQueue length=${freshSnap.reviewQueue.length}; composeWorkbenchSnapshot in src/screen/workbench/selectors.ts must queue an artifact whose treeDigest matches the generation digest`)
}

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nprove-parity: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nprove-parity: green')
