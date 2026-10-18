import { missionEnabled } from '../../src/services/mission/contracts.js'
import {
  buildMissionRow,
  composeMissionView,
  type MissionInputs,
} from '../../src/services/mission/projection.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

const BASE: MissionInputs = {
  workspace: '/tmp/proj',
  runObjective: null,
  runLifecycle: null,
  snapshot: null,
  memoryRefs: [],
  executions: [],
  evidenceDigest: null,
  model: 'claude-fable-5-1',
  now: 1000,
}

check('idle ⇒ no view', composeMissionView(BASE) === null)
check(
  'terminal-only run ⇒ view carries outcome, not idle',
  composeMissionView({ ...BASE, runObjective: 'done thing', runLifecycle: 'completed' }) !== null,
)

const solo = composeMissionView({ ...BASE, runObjective: 'fix the wrap bug', runLifecycle: 'active' })
check('view exists', solo !== null)
check('goal is the run objective', solo?.goal.source === 'run-objective' && solo?.goal.text === 'fix the wrap bug')
check("the policy is the session's model", solo?.policy.model === 'claude-fable-5-1' && solo?.policy.source === 'session-model')
check('the view carries no plan, posture or profile field', !('plans' in (solo ?? {})) && !('replan' in (solo ?? {})) && !('posture' in (solo?.policy ?? {})) && !('profile' in (solo?.policy ?? {})))
check('no outcome while active', solo?.outcome === null)
check('a session without a model still composes (the fact is null, never invented)', composeMissionView({ ...BASE, model: null, runObjective: 'x', runLifecycle: 'active' })?.policy.model === null)

const armed = composeMissionView({
  ...BASE,
  card: { sessionId: 's1', goal: 'ship the fix', state: 'armed', nextStep: null, iterations: 0, updatedAt: 'now' },
})
check('an armed /mission card is a mission-shaped fact', armed?.goal.source === 'mission-card' && armed?.goal.text === 'ship the fix')
const settledCard = composeMissionView({
  ...BASE,
  card: { sessionId: 's1', goal: 'ship the fix', state: 'met', nextStep: null, iterations: 1, updatedAt: 'now' },
})
check('a settled card arms nothing', settledCard === null)

const again = composeMissionView({ ...BASE, runObjective: 'fix the wrap bug', runLifecycle: 'active' })
check('identical inputs ⇒ identical view', JSON.stringify(solo) === JSON.stringify(again))
const later = composeMissionView({ ...BASE, runObjective: 'fix the wrap bug', runLifecycle: 'active', now: 99999 })
check('missionId is clock-independent', solo?.missionId === later?.missionId)
const otherModel = composeMissionView({ ...BASE, runObjective: 'fix the wrap bug', runLifecycle: 'active', model: 'gpt-5.5' })
check('missionId is the workspace + goal, never the model', solo?.missionId === otherModel?.missionId)

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
  executions: Array.from({ length: 20 }, (_, i) => ({ kind: 'process', id: 'p' + i, state: 'running' })),
})
check('memory cap 6', noisy?.memory.length === 6)
check('execution cap 12', noisy?.executions.length === 12)

const settled = composeMissionView({ ...BASE, runObjective: 'x', runLifecycle: 'completed' })
check('terminal run ⇒ outcome', settled?.outcome?.state === 'completed')

check('null view folds to null row', buildMissionRow(null) === null)
const row = buildMissionRow(solo)
check('mission row shaped', row?.section === 'MISSION' && (row?.detail.length ?? 0) >= 4)
check("row drill-in names the session's model", (row?.detail ?? []).some(d => d.includes('claude-fable-5-1') && d.includes('the session model')))
check('row line leads with the model', row?.line.startsWith('claude-fable-5-1') === true)
check('row tone is accent while the mission is live', row?.tone === 'accent')
check('row tone settles with the outcome', buildMissionRow(settled)?.tone === 'ok')

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
