// ============================================================================
//  scripts/golden-journeys/journey-j2.ts — J2: diagnose and fix (frozen golden
//  journey, M0).
//
//  Start from a failing check, orient, find the cause, implement a
//  correction, run the check again, review the diff and finish. Seeded as
//  the real persisted shapes: FAIL output → Edit → PASS output → close, a
//  verified completed sidecar, and the live uncommitted change for /diff.
// ============================================================================

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

// ── C1: resume — cause and resolution are the first feedback ────────────────
const walker = new JourneyWalker(sid, 'j2')
const glance = walker.glance()
check('the diagnosis (root cause) is on screen', hasProse(glance, 'Root cause'))
check('the passing re-check is reported', hasProse(glance, 'now reports PASS'))

// ── frozen fact probes ──────────────────────────────────────────────────────
const facts = [
  walker.probeFact('outcome', 'failing greeting check', [{ cmd: '/run' }]),
  walker.probeFact('changed', 'greet.ts', [{ cmd: '/run' }, { cmd: '/diff' }]),
  walker.probeFact('completion-evidence', 'checks: verified', [{ cmd: '/run' }]),
]

// ── review the fix ──────────────────────────────────────────────────────────
const diff = walker.nav({ cmd: '/diff' })
check('/diff lists the fixed file', diff.text.includes('greet.ts'))

const escBack = capture({
  sid,
  tag: 'j2-diff-esc',
  sends: [...slashSends('/diff'), { afterPrevTicks: 40, data: '\x1b' }],
  total: 130,
})
check('esc returns from review to the composer', /❯/.test(escBack.text))

// ── report ──────────────────────────────────────────────────────────────────
// Measured review accounting — the J1 note applies verbatim.
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
