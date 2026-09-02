// ============================================================================
//  scripts/golden-journeys/journey-j4.ts — J4: leave and resume (frozen golden
//  journey, M0).
//
//  J3's substantial state terminated at adversarial boundaries, then
//  reopened: the journey MEASURES work-identity recovery (does the durable
//  run reconstruct? are the facts visible again? is any effect duplicated?)
//  rather than hard-asserting it — the baseline records today's truth
//  (finding F1: CLI --resume never reconciles the sidecar) and the M6
//  acceptance compares the after-state on the same frozen probes.
//
//  Boundaries exercised:
//    B1 clean-idle kill (capture A ends → SIGHUP mid-session);
//    B2 immediate re-kill DURING boot (a 4-second capture window);
//    B3 full reopen after the torn boot.
// ============================================================================

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

// Replay accounting counts CONVERSATION rows only: every resume legitimately
// appends one `away_summary` system row (the away-recap dual-write) — that is
// a recap, not a replayed message or effect.
const conversationRowCount = () =>
  readFileSync(sessionPath(sid), 'utf8')
    .trim()
    .split('\n')
    .filter(line => !line.includes('"type":"system"')).length
const rowsBefore = conversationRowCount()
const seedSidecar = readRunSidecar(sid)

// ── B1: open, look, die (the capture end IS the adversarial kill) ───────────
const bootA = capture({ sid, tag: 'j4-boot-a' })
check('boot A renders the resumed session', bootA.ok && hasProse(bootA, 'wiring the config loader'))
const afterA = readRunSidecar(sid)

// ── B2: torn boot — kill inside the boot window ─────────────────────────────
const torn = capture({ sid, tag: 'j4-boot-torn', total: 20, stableTicks: 0 })
void torn // the frame content is irrelevant; the kill timing is the point

// ── B3: full reopen after the torn boot ─────────────────────────────────────
const walker = new JourneyWalker(sid, 'j4')
const bootB = walker.glance('boot-b')
// The stacked away-recap cards scroll the old prose off — the recap card
// itself is the stable resumed-render needle.
check('boot B renders after the torn boot', bootB.ok && hasProse(bootB, 'resumed clean'))
const afterB = readRunSidecar(sid)
const rowsAfter = conversationRowCount()

// ── structural identity laws (must hold in EVERY state, before and after) ───
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

// ── measurement (baseline truth vs after-state, compared by score.ts) ───────
const reconciledOnResume =
  afterB.writeSeq > seedSidecar.writeSeq ||
  afterB.snapshot.recentEvents.some(e => e.type === 'resumed')
const runFacts = walker.probeFact('outcome', J3_OBJECTIVE.slice(0, 24), [{ cmd: '/run' }])
const identityRecovered = runFacts.visibility !== 'not-visible'

// The F1 hard pins ("the resumed INTERACTIVE boot reconciles the sidecar" ·
// "/run answers after resume") retired with their subject: the unified
// resume paints the transcript and admits the daemon session — the sidecar
// can advance behind the admit (the report's reconciled fact measures it) —
// but no screen-side surface answers over the focused chat: /run reads the
// process-main owner, blind to the resumed seed (the lead-queued terminal
// gap the parity prover names). Successor pins: B4 below hard-pins the
// surviving OWNED reconcile door (the print-family resume advances the
// sidecar through the real coordinator), and the report's
// sidecar-reconciled/identity facts keep measuring the interactive truth
// for the acceptance comparison.

// ── B4: the print-family destruction probe (logic finding A, fixed at the
// print boot + the sidecar monotonicity belt): `-p --resume` with the
// synthetic key — the API call fails; the guarded class is a first turn that
// has ALREADY minted a fresh runId and atomically clobbered the non-terminal
// sidecar with a regressed write sequence. The durable identity must
// survive. Runs LAST: its new ask legitimately refreshes the objective
// (request-accepted law), so the visibility probes above precede it.
const beforePrint = readRunSidecar(sid)
spawnSync('node', [DIST, '-p', 'continue the work', '--resume', sid], {
  encoding: 'utf-8',
  timeout: 120_000,
  cwd: FIXTURE_CWD,
  env: journeyChildEnv(),
})
const afterPrint = readRunSidecar(sid)
check('B4: a print-mode resume preserves the durable runId (finding A)', afterPrint.snapshot.runId === beforePrint.snapshot.runId)
// ADVANCES, not merely never-regresses (the verify pass proved >= is vacuous
// here: the pre-fix dist dies at the key preflight without touching the
// sidecar at all). The fixed boot's awaited reconcile FLUSHES — the sequence
// moves forward; an unfixed boot leaves it exactly where it was.
check('B4: the print resume ADVANCES the sidecar (the reconcile engaged)', afterPrint.writeSeq > beforePrint.writeSeq)

// ── C3 law: a capture that never painted is a HARNESS failure ───────────────
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
