
import {
  DIST,
  FIXTURE_CWD,
  SIDS,
  JourneyWalker,
  capture,
  cleanupWorld,
  hasProse,
  journeyChildEnv,
  makeChecker,
  readRunSidecar,
  reportPath,
  requireDist,
  seedWorld,
  sessionPath,
  writeReport,
} from './journeyLib.ts'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { J3_OBJECTIVE, seedSubstantialState } from './j3State.ts'

requireDist()
const { check, failures } = makeChecker()
console.log('J4 — leave and resume (frozen golden journey)')

seedWorld()
const sid = SIDS.J4
seedSubstantialState(sid)

const conversationRowCount = () =>
  readFileSync(sessionPath(sid), 'utf8')
    .trim()
    .split('\n')
    .filter(line => !line.includes('"type":"system"')).length
const rowsBefore = conversationRowCount()
const seedSidecar = readRunSidecar(sid)

const bootA = capture({ sid, tag: 'j4-boot-a' })
check('boot A renders the resumed session', bootA.ok && hasProse(bootA, 'wiring the config loader'))
const afterA = readRunSidecar(sid)

const torn = capture({ sid, tag: 'j4-boot-torn', total: 20, stableTicks: 0 })
void torn

const walker = new JourneyWalker(sid, 'j4')
const bootB = walker.glance('boot-b')
check('boot B renders after the torn boot', bootB.ok && hasProse(bootB, 'resumed clean'))
const afterB = readRunSidecar(sid)
const rowsAfter = conversationRowCount()

check('run identity survives every boundary', afterB.snapshot.runId === seedSidecar.snapshot.runId)
check(
  'no duplicate deliverables after restarts',
  new Set(afterB.snapshot.deliverables.map(d => d.id)).size === afterB.snapshot.deliverables.length,
)
check(
  'observed changed paths are never duplicated',
  new Set(afterB.snapshot.changedPaths).size === afterB.snapshot.changedPaths.length,
)
check('the sidecar stays structurally loadable', typeof afterB.snapshot.objective === 'string')

const reconciledOnResume =
  afterB.writeSeq > seedSidecar.writeSeq ||
  afterB.snapshot.recentEvents.some(e => e.type === 'resumed')
const runFacts = walker.probeFact('outcome', J3_OBJECTIVE.slice(0, 24), [{ cmd: '/run' }])
const identityRecovered = runFacts.visibility !== 'not-visible'


const beforePrint = readRunSidecar(sid)
spawnSync('node', [DIST, '-p', 'continue the work', '--resume', sid], {
  encoding: 'utf-8',
  timeout: 120_000,
  cwd: FIXTURE_CWD,
  env: journeyChildEnv(),
})
const afterPrint = readRunSidecar(sid)
check('B4: a print-mode resume preserves the durable runId (finding A)', afterPrint.snapshot.runId === beforePrint.snapshot.runId)
check('B4: the print resume ADVANCES the sidecar (the reconcile engaged)', afterPrint.writeSeq > beforePrint.writeSeq)

check('every walker capture painted (C3)', walker.failedCaptures.length === 0, walker.failedCaptures.join(' · '))

writeReport({
  journey: 'J4',
  completed: failures().length === 0,
  integrityFailures: failures(),
  facts: [
    {
      fact: 'sidecar-reconciled-on-resume',
      needle: 'writeSeq/resumed-event',
      visibility: reconciledOnResume ? 'at-glance' : 'not-visible',
      transitions: 0,
      route: null,
    },
    runFacts,
    {
      fact: 'no-replay',
      needle: 'transcript row count stable',
      visibility: rowsAfter === rowsBefore ? 'at-glance' : 'not-visible',
      transitions: 0,
      route: null,
    },
  ],
  specialistCommands: runFacts.route ? [runFacts.route] : [],
  surfaceTransitions: runFacts.transitions,
  stepsToFirstFeedback: 1,
  stepsToReviewedChange: null,
  repeatedActions: 0,
  staleOrContradictoryFacts: identityRecovered ? 0 : 1,
  freshCheckAtClosure: false,
})
console.log(
  `  report → ${reportPath('J4')} (reconciled=${reconciledOnResume} identityVisible=${identityRecovered} rows ${rowsBefore}→${rowsAfter} seq ${seedSidecar.writeSeq}→${afterA.writeSeq}→${afterB.writeSeq})`,
)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nJ4: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nJ4: green')
