
import {
  hasProse,
  SIDS,
  JourneyWalker,
  bashRound,
  capture,
  cleanupWorld,
  conversationRows,
  editRound,
  foldRun,
  makeChecker,
  readRunSidecar,
  reportPath,
  requireDist,
  seedWorld,
  slashSends,
  writeReport,
  writeRunSidecar,
  writeSession,
} from './journeyLib.ts'

requireDist()
const { check, failures } = makeChecker()
console.log('J1 — first useful change (frozen golden journey)')

seedWorld()
const sid = SIDS.J1
const OBJECTIVE = 'Fix the fixture greeting to include the caller name'

writeSession(
  sid,
  conversationRows(
    sid,
    OBJECTIVE,
    [
      editRound('src/greet.ts', 'return `hello`', 'return `hello, ${name}`', 'toolu_j1_edit1'),
      bashRound('./check.sh alice', 'Run the greeting check', 'PASS', 'toolu_j1_bash1'),
    ],
    'Done — greet() now includes the caller name and check.sh reports PASS.',
  ),
)

const t0 = Date.parse('2026-07-20T12:00:00.000Z')
writeRunSidecar(
  sid,
  foldRun(sid, 'run_momentum_j1', OBJECTIVE, [
    { type: 'substantive', at: t0 + 2000, reason: 'invoked Edit' },
    {
      type: 'tool-effected',
      at: t0 + 3000,
      toolName: 'Edit',
      toolUseId: 'toolu_j1_edit1',
      operation: 'edit apply',
      outcome: 'succeeded',
      changedPaths: ['src/greet.ts'],
    },
    { type: 'evidence', at: t0 + 5000, state: 'verified', detail: 'check.sh PASS on the current tree' },
    { type: 'completed', at: t0 + 6000, satisfied: ['greeting includes the caller name'] },
  ]),
)

const walker = new JourneyWalker(sid, 'j1')
const glance = walker.glance()
check('the closing report is on screen', hasProse(glance, 'check.sh reports PASS'))
check('the resume recap card renders', hasProse(glance, 'resumed clean'))

const facts = [
  walker.probeFact('outcome', 'Fix the fixture greeting', [{ cmd: '/run' }]),
  walker.probeFact('changed', 'greet.ts', [{ cmd: '/run' }, { cmd: '/diff' }]),
  walker.probeFact('completion-evidence', 'checks: verified', [{ cmd: '/run' }]),
]

const diff = walker.nav({ cmd: '/diff' })
check('/diff mounts the review workspace', diff.ok && /diff|review|sources/i.test(diff.text))
check('/diff lists the real changed file', diff.text.includes('greet.ts'))

const escBack = capture({
  sid,
  tag: 'j1-diff-esc',
  sends: [...slashSends('/diff'), { afterPrevTicks: 40, data: '\x1b' }],
  total: 130,
})
check('esc returns from review to the composer', /❯/.test(escBack.text))

const sidecar = readRunSidecar(sid)
check('the completed sidecar stays terminal after resume', sidecar.snapshot.lifecycle === 'completed')
check('run identity is stable', sidecar.snapshot.runId === 'run_momentum_j1')

const reviewOffer = walker.probeFact('review-offer', 'review', [])
const specialist = new Set<string>()
for (const f of facts) if (f.route) specialist.add(f.route)
if (reviewOffer.visibility !== 'at-glance') specialist.add('/diff')
facts.push(reviewOffer)
check('every walker capture painted (C3)', walker.failedCaptures.length === 0, walker.failedCaptures.join(' · '))

writeReport({
  journey: 'J1',
  completed: failures().length === 0,
  integrityFailures: failures(),
  facts,
  specialistCommands: [...specialist].sort(),
  surfaceTransitions: facts.reduce((n, f) => n + f.transitions, 0) + 1 ,
  stepsToFirstFeedback: 1,
  stepsToReviewedChange: 1 + facts.filter(f => f.visibility === 'after-navigation').length,
  repeatedActions: 0,
  staleOrContradictoryFacts: 0,
  freshCheckAtClosure: facts.find(f => f.fact === 'completion-evidence')?.visibility !== 'not-visible',
})
console.log(`  report → ${reportPath('J1')}`)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nJ1: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nJ1: green')
