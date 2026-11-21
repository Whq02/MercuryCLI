
import {
  SIDS,
  JourneyWalker,
  bashRound,
  capture,
  cleanupWorld,
  conversationRows,
  editRound,
  foldRun,
  hasProse,
  makeChecker,
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
console.log('J2 — diagnose and fix (frozen golden journey)')

seedWorld()
const sid = SIDS.J2
const OBJECTIVE = 'Diagnose the failing greeting check and fix the cause'

writeSession(
  sid,
  conversationRows(
    sid,
    OBJECTIVE,
    [
      bashRound('./check.sh world', 'Reproduce the failing check', 'FAIL', 'toolu_j2_bash1'),
      editRound('src/greet.ts', 'return `hello`', 'return `hello, ${name}`', 'toolu_j2_edit1'),
      bashRound('./check.sh world', 'Re-run the check after the fix', 'PASS', 'toolu_j2_bash2'),
    ],
    'Root cause: greet() dropped the name argument. Fixed; check.sh world now reports PASS.',
  ),
)

const t0 = Date.parse('2026-07-20T12:00:00.000Z')
writeRunSidecar(
  sid,
  foldRun(sid, 'run_momentum_j2', OBJECTIVE, [
    { type: 'substantive', at: t0 + 2000, reason: 'invoked Bash' },
    {
      type: 'tool-effected',
      at: t0 + 4000,
      toolName: 'Edit',
      toolUseId: 'toolu_j2_edit1',
      operation: 'edit apply',
      outcome: 'succeeded',
      changedPaths: ['src/greet.ts'],
    },
    { type: 'evidence', at: t0 + 6000, state: 'verified', detail: 'check.sh world PASS on the current tree' },
    { type: 'completed', at: t0 + 7000, satisfied: ['the greeting check passes'] },
  ]),
)

const walker = new JourneyWalker(sid, 'j2')
const glance = walker.glance()
check('the diagnosis (root cause) is on screen', hasProse(glance, 'Root cause'), 'the resumed session should paint the final assistant message at first glance; rebuild dist and check how the resumed conversation is rendered, or whether the capture painted at all')
check('the passing re-check is reported', hasProse(glance, 'now reports PASS'), 'the final assistant line should be visible at first glance in the resumed session; rebuild dist and check how the resumed conversation is rendered')

const facts = [
  walker.probeFact('outcome', 'failing greeting check', [{ cmd: '/run' }]),
  walker.probeFact('changed', 'greet.ts', [{ cmd: '/run' }, { cmd: '/diff' }]),
  walker.probeFact('completion-evidence', 'checks: verified', [{ cmd: '/run' }]),
]

const diff = walker.nav({ cmd: '/diff' })
check('/diff lists the fixed file', diff.text.includes('greet.ts'), 'src/greet.ts was edited by the Edit tool round in the seeded session, so the /diff review (src/commands/diff/diff.tsx) should list it; check how it collects per-turn changes')

const escBack = capture({
  sid,
  tag: 'j2-diff-esc',
  sends: [...slashSends('/diff'), { afterPrevTicks: 40, data: '\x1b' }],
  total: 130,
})
check('esc returns from review to the composer', /❯/.test(escBack.text), 'Esc in the /diff review (src/commands/diff/diff.tsx) should close it and leave the composer prompt on screen; check its Esc handling')

const reviewOffer = walker.probeFact('review-offer', 'review', [])
const specialist = new Set<string>()
for (const f of facts) if (f.route) specialist.add(f.route)
if (reviewOffer.visibility !== 'at-glance') specialist.add('/diff')
facts.push(reviewOffer)
check('every walker capture painted (C3)', walker.failedCaptures.length === 0, walker.failedCaptures.join(' · '))

writeReport({
  journey: 'J2',
  completed: failures().length === 0,
  integrityFailures: failures(),
  facts,
  specialistCommands: [...specialist].sort(),
  surfaceTransitions: facts.reduce((n, f) => n + f.transitions, 0) + 1,
  stepsToFirstFeedback: 1,
  stepsToReviewedChange: 1 + facts.filter(f => f.visibility === 'after-navigation').length,
  repeatedActions: 0,
  staleOrContradictoryFacts: 0,
  freshCheckAtClosure: facts.find(f => f.fact === 'completion-evidence')?.visibility !== 'not-visible',
})
console.log(`  report → ${reportPath('J2')}`)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nJ2: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nJ2: green')
