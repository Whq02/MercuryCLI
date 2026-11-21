
import {
  SIDS,
  JourneyWalker,
  cleanupWorld,
  hasProse,
  makeChecker,
  readRunSidecar,
  reportPath,
  requireDist,
  seedWorld,
  writeReport,
} from './journeyLib.ts'
import { seedSubstantialState } from './j3State.ts'

requireDist()
const { check, failures } = makeChecker()
console.log('J3 — substantial multi-stage change (frozen golden journey)')

seedWorld()
const sid = SIDS.J3
seedSubstantialState(sid)

const walker = new JourneyWalker(sid, 'j3')
const glance = walker.glance()
check(
  'resume renders the mid-flight report',
  hasProse(glance, 'wiring the config loader'),
  'the resumed session screen lacks the in-progress deliverable text; check the seeded run in scripts/golden-journeys/j3State.ts (seedSubstantialState) and the capture text in the vshot output',
)

const ROUTES = [{ cmd: '/run' }, { cmd: '/tasks' }, { cmd: '/diff' }, { cmd: '/workbench' }]
const facts = [
  walker.probeFact('outcome', 'Modernize the fixture demo', ROUTES),
  walker.probeFact('doing-now', 'wire the config loader', ROUTES),
  walker.probeFact('changed', 'greet.ts', ROUTES),
  walker.probeFact('remains', 'document the new commands', ROUTES),
  walker.probeFact('blocked', 'publish the release notes', ROUTES),
  walker.probeFact('proposed-next', 'continue the open deliverable', ROUTES),
  walker.probeFact('completion-evidence', 'checks: unverified', [{ cmd: '/run' }]),
]

const sidecar = readRunSidecar(sid)
check(
  'the durable run holds the seeded plan (2 done · 1 in-progress · 2 open)',
  sidecar.snapshot.deliverables.filter(d => d.state === 'done').length === 2 &&
    sidecar.snapshot.deliverables.filter(d => d.state === 'in-progress').length === 1 &&
    sidecar.snapshot.deliverables.filter(d => d.state === 'open').length === 2,
  'the run sidecar written by seedSubstantialState (scripts/golden-journeys/j3State.ts) or folded by the app on resume no longer holds 2 done, 1 in-progress and 2 open deliverables; compare snapshot.deliverables states in the sidecar from readRunSidecar',
)
const panel = walker.nav({ cmd: '/workbench' })
check(
  "the prompts panel carries the chat's ask (the receipt roll)",
  hasProse(panel, 'Modernize the fixture demo'),
  'the /workbench capture does not show the seeded objective (J3_OBJECTIVE in scripts/golden-journeys/j3State.ts); the workbench prompts panel is not listing the chat ask',
)

const specialist = new Set<string>()
for (const f of facts) if (f.route) specialist.add(f.route)
const unanswered = facts.filter(f => f.visibility === 'not-visible').length
check('every walker capture painted (C3)', walker.failedCaptures.length === 0,
  `${walker.failedCaptures.join(' · ')} — a capture painted under 40 cells on every attempt; rebuild dist/mercury.mjs and rerun, or inspect the capture function in scripts/golden-journeys/journeyLib.ts`,
)

writeReport({
  journey: 'J3',
  completed: failures().length === 0,
  integrityFailures: failures(),
  facts,
  specialistCommands: [...specialist].sort(),
  surfaceTransitions: facts.reduce((n, f) => n + f.transitions, 0),
  stepsToFirstFeedback: 1,
  stepsToReviewedChange: null,
  repeatedActions: 0,
  staleOrContradictoryFacts: unanswered,
  freshCheckAtClosure: false,
})
console.log(`  report → ${reportPath('J3')} (unanswered facts: ${unanswered}/7)`)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nJ3: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nJ3: green')
