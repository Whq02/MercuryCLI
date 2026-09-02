// ============================================================================
//  prove-mission-projection.ts — the H2 MissionView composition laws (pure).
// ----------------------------------------------------------------------------
//    1. idle law: no goal + no live plan ⇒ NO view (no permanent furniture);
//    2. solo mission: run objective ⇒ goal[run-objective] + current-default
//       policy with the 'no-route-plan' reason;
//    3. routed mission: route plans project as REFERENCES (plan/node ids,
//       decision reason codes) — the policy fact is the router's own decision;
//    4. purity/determinism: identical inputs ⇒ identical view; missionId is
//       stable across time (never derived from the clock);
//    5. no duplicate lifecycle: a plan-state change reflects on the NEXT
//       composition (derived, not cached) and the view's plan states are the
//       store's states verbatim;
//    6. caps hold (memory ≤ 6 · plans ≤ 4 · decision points ≤ 4);
//    7. outcome appears only when the run lifecycle is terminal and no plan
//       stays active;
//    8. the /run fold: null ⇒ null; active view ⇒ ONE MISSION row with
//       drill-in detail;
//    9. the gate re-reads MERCURY_MISSION live (authority-toggle law).
// ============================================================================
import { missionEnabled } from '../../src/services/mission/contracts.js'
import {
  buildMissionRow,
  composeMissionView,
  type MissionInputs,
} from '../../src/services/mission/projection.js'
import type { TaskRoutePlan } from '../../src/utils/router/contracts.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

function plan(overrides: Partial<TaskRoutePlan> = {}): TaskRoutePlan {
  return {
    version: 1,
    id: 'rp-test-1',
    revision: 2,
    mode: 'sequential',
    title: 'fix the relay lanes',
    objective: 'repair three route modules',
    features: {} as TaskRoutePlan['features'],
    profile: 'wide',
    nodes: [
      {
        id: 'n1',
        title: 'fix alpha',
        task: 'fix alpha',
        dependsOn: [],
        ownsPaths: ['src/routes/alpha.js'],
        acceptance: [],
        state: 'working',
        attempt: 1,
        expectedResult: 'tests green',
        assignedWorker: 'dps1',
        assignedModel: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          modelClass: 'sonnet',
          effort: 'high',
          contextWindow: 200000,
        },
      },
      {
        id: 'n2',
        title: 'fix beta',
        task: 'fix beta',
        dependsOn: ['n1'],
        ownsPaths: ['src/routes/beta.js'],
        acceptance: [],
        state: 'held',
        attempt: 1,
        expectedResult: 'tests green',
      },
    ],
    synthesis: { required: true, owner: 'planner', acceptance: [] },
    decision: {
      policyVersion: 'v1',
      source: 'structured-intent',
      posture: 'adaptive',
      selectedProfile: 'wide',
      selectedModels: [],
      decisiveReasons: ['separable-ownership', 'crisp-nodes'],
      displayReasons: ['lanes are disjoint'],
      adjustments: [],
    } as TaskRoutePlan['decision'],
    state: 'running',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as TaskRoutePlan
}

const BASE: MissionInputs = {
  workspace: '/tmp/proj',
  runObjective: null,
  runLifecycle: null,
  plans: [],
  snapshot: null,
  memoryRefs: [],
  executions: [],
  evidenceDigest: null,
  posture: 'adaptive',
  nodeAttemptCeiling: 3,
  now: 1000,
}

// 1 · idle law.
check('idle ⇒ no view', composeMissionView(BASE) === null)
check(
  'terminal-only run without plans ⇒ view carries outcome, not idle',
  composeMissionView({ ...BASE, runObjective: 'done thing', runLifecycle: 'completed' }) !== null,
)

// 2 · solo mission.
const solo = composeMissionView({ ...BASE, runObjective: 'fix the wrap bug', runLifecycle: 'active' })
check('solo view exists', solo !== null)
check('solo goal is the run objective', solo?.goal.source === 'run-objective' && solo?.goal.text === 'fix the wrap bug')
check('solo policy is the current default', solo?.policy.profile === 'solo-default' && solo?.policy.source === 'current-default')
check('solo policy names the reason', (solo?.policy.reasonCodes ?? []).includes('no-route-plan'))
check('solo has no plans and no outcome', solo?.plans.length === 0 && solo?.outcome === null)

// 3 · routed mission.
const routed = composeMissionView({ ...BASE, plans: [plan()], runObjective: 'x', runLifecycle: 'active' })
check('routed policy is the route decision', routed?.policy.source === 'route-decision' && routed?.policy.profile === 'wide')
check('routed reason codes referenced', (routed?.policy.reasonCodes ?? []).join(',') === 'separable-ownership,crisp-nodes')
check('plan referenced by id+revision', routed?.plans[0]?.planId === 'rp-test-1' && routed?.plans[0]?.revision === 2)
check('node refs carry state/attempt/owner', routed?.plans[0]?.nodes[0]?.state === 'working' && routed?.plans[0]?.nodes[0]?.worker === 'dps1')
check('node model referenced', routed?.plans[0]?.nodes[0]?.model === 'claude-sonnet-5')
check('held node becomes a decision point', (routed?.decisionPoints ?? []).some(d => d.includes('n2') && d.includes('held')))
check('replan allowance references the router ceiling', routed?.replan.nodeAttemptCeiling === 3 && routed?.replan.planRevisions === 1)

// 4 · purity/determinism + clock independence of identity.
const again = composeMissionView({ ...BASE, plans: [plan()], runObjective: 'x', runLifecycle: 'active' })
check('identical inputs ⇒ identical view', JSON.stringify(routed) === JSON.stringify(again))
const later = composeMissionView({ ...BASE, plans: [plan()], runObjective: 'x', runLifecycle: 'active', now: 99999 })
check('missionId is clock-independent', routed?.missionId === later?.missionId)

// 4b · §9 acceptance preview for reported nodes (the completion evaluator
//      consumed in-product — checks-reported ⇒ grader stage; unresolved
//      effects ⇒ divergence ⇒ revise preview).
const reported = composeMissionView({
  ...BASE,
  runObjective: 'x',
  runLifecycle: 'active',
  plans: [
    plan({
      nodes: [
        {
          ...plan().nodes[0],
          state: 'reported' as const,
          completion: {
            summary: 'alpha fixed',
            checksReported: ['node --test'],
            changedAreas: ['src/routes/alpha.js'],
            unresolved: ['beta untouched'],
            reportedAt: 5,
          },
        },
      ],
    }),
  ],
})
check(
  'reported node carries the §9 acceptance preview',
  (reported?.decisionPoints ?? []).some(d => d.includes('n1 reported') && d.includes('revise') && d.includes('1 unresolved')),
)

// 5 · derived, never cached.
const advanced = composeMissionView({
  ...BASE,
  plans: [plan({ nodes: plan().nodes.map(n => ({ ...n, state: 'accepted' as const })) })],
  runObjective: 'x',
  runLifecycle: 'active',
})
check('plan-state change reflects on next composition', advanced?.plans[0]?.nodes[0]?.state === 'accepted')

// 6 · caps.
const noisy = composeMissionView({
  ...BASE,
  runObjective: 'x',
  runLifecycle: 'active',
  memoryRefs: Array.from({ length: 20 }, (_, i) => ({
    refId: 'mneme:' + i,
    kind: 'fact',
    store: 'mneme',
    scope: 'project',
    status: 'current',
    summary: 's',
    why: 'w',
    deref: 'd',
    tier: 1,
  })) as MissionInputs['memoryRefs'],
  plans: Array.from({ length: 8 }, (_, i) => plan({ id: 'rp-' + i })),
})
check('memory cap 6', noisy?.memory.length === 6)
check('plan cap 4', noisy?.plans.length === 4)
check('decision-point cap 4', (noisy?.decisionPoints.length ?? 99) <= 4)

// 7 · outcome law.
const settled = composeMissionView({
  ...BASE,
  runObjective: 'x',
  runLifecycle: 'completed',
  plans: [plan({ state: 'accepted' })],
})
check('terminal run + settled plans ⇒ outcome', settled?.outcome?.state === 'completed')
const stillActive = composeMissionView({
  ...BASE,
  runObjective: 'x',
  runLifecycle: 'completed',
  plans: [plan()],
})
check('live plan blocks the outcome', stillActive?.outcome === null)

// 8 · the /run fold.
check('null view folds to null row', buildMissionRow(null) === null)
const row = buildMissionRow(routed)
check('mission row shaped', row?.section === 'MISSION' && (row?.detail.length ?? 0) > 3)
check('row drill-in names the plan', (row?.detail ?? []).some(d => d.includes('rp-test-1')))
check('row tone warns on decision points', row?.tone === 'warn')

// 9 · live gate re-read.
const before = missionEnabled()
process.env.MERCURY_MISSION = '0'
const offReads = missionEnabled()
delete process.env.MERCURY_MISSION
check('gate re-reads live', before === true && offReads === false && missionEnabled() === true)

if (failures > 0) {
  console.error('prove-mission-projection: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-mission-projection: green')
