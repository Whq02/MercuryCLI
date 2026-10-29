
import {
  SIDS,
  JourneyWalker,
  capture,
  cleanupWorld,
  hasProse,
  makeChecker,
  purgeDraft,
  readRunSidecar,
  reportPath,
  requireDist,
  seedWorld,
  writeReport,
  type Send,
} from './journeyLib.ts'
import { J3_OBJECTIVE, seedSubstantialState } from './j3State.ts'

requireDist()
const { check, failures } = makeChecker()
console.log('J5 — expert intervention (frozen golden journey)')

seedWorld()
const sid = SIDS.J5
seedSubstantialState(sid)

const DRAFT = 'also cover the parser edge cases'

function paletteJourney(query: string, close: boolean): Send[] {
  return [
    { atTick: 55, minTick: 5, awaitRaw: '\x1b[?2004h', data: DRAFT },
    { afterPrevTicks: 6, data: '\x18' },
    { afterPrevTicks: 3, data: 'p' },
    { afterPrevTicks: 6, data: query },
    { afterPrevTicks: 6, data: '\r' },
    ...(close ? [{ afterPrevTicks: 40, data: '\x1b' }] : []),
  ]
}

const openBoard = capture({ sid, tag: 'j5-workbench-open', sends: paletteJourney('workbench', false), total: 150 })
check(
  'the palette hands /workbench to the composer beside the held draft, unsent',
  hasProse(openBoard, `${DRAFT} /workbench`),
)

const backFromBoard = capture({ sid, tag: 'j5-workbench-esc', sends: paletteJourney('workbench', true), total: 170 })
check('esc returns to the composer', /❯/.test(backFromBoard.text))
const draftSurvivesBoard = hasProse(backFromBoard, DRAFT)
check('the draft survives the workbench excursion', draftSurvivesBoard)

const backFromDiff = capture({ sid, tag: 'j5-diff-esc', sends: paletteJourney('diff', true), total: 170 })
const draftSurvivesDiff = hasProse(backFromDiff, DRAFT)
check('the draft survives the review excursion', draftSurvivesDiff)

purgeDraft(sid)
const walker = new JourneyWalker(sid, 'j5')
const glance = walker.glance()
check('the session resumes cleanly after excursions', hasProse(glance, 'resumed clean'))
const sidecarAfter = readRunSidecar(sid)
check(
  'the work identity survives the excursions (the durable run holds the five plan items)',
  sidecarAfter.snapshot.objective === J3_OBJECTIVE && sidecarAfter.snapshot.deliverables.length === 5,
)
const panelAfter = walker.nav({ cmd: '/workbench' })
check("the chat's ask is still reachable (the prompts panel receipt roll)", hasProse(panelAfter, 'Modernize the fixture demo'))

check('every walker capture painted (C3)', walker.failedCaptures.length === 0, walker.failedCaptures.join(' · '))

writeReport({
  journey: 'J5',
  completed: failures().length === 0,
  integrityFailures: failures(),
  facts: [
    {
      fact: 'draft-preserved',
      needle: DRAFT,
      visibility: draftSurvivesBoard && draftSurvivesDiff ? 'at-glance' : 'not-visible',
      transitions: 0,
      route: null,
    },
  ],
  specialistCommands: ['/workbench', '/diff'],
  surfaceTransitions: 2,
  stepsToFirstFeedback: 1,
  stepsToReviewedChange: 2,
  repeatedActions: 0,
  staleOrContradictoryFacts: 0,
  freshCheckAtClosure: false,
})
console.log(`  report → ${reportPath('J5')}`)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nJ5: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nJ5: green')
