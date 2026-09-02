// ============================================================================
//  scripts/golden-journeys/journey-j3.ts — J3: substantial multi-stage change
//
//
//  An objective with five dependent work items mid-execution: the walker
//  probes the SEVEN operator facts — outcome · doing-now ·
//  changed · remains · blocked · proposed-next · completion-evidence — at
//  glance first, then through today's specialist routes. The seven-facts
//  visibility vector IS the headline metric.
// ============================================================================

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
check('resume renders the mid-flight report', hasProse(glance, 'wiring the config loader'))

// ── the seven operator facts, frozen ────────────────────────────────────────────
// Routes are today's specialist surfaces (re-declarable by design; the
// needles stay frozen): /workbench is the prompts panel — the receipt roll
// carries the focused chat's asks.
const ROUTES = [{ cmd: '/run' }, { cmd: '/tasks' }, { cmd: '/diff' }, { cmd: '/workbench' }]
const facts = [
  walker.probeFact('outcome', 'Modernize the fixture demo', ROUTES),
  walker.probeFact('doing-now', 'wire the config loader', ROUTES),
  walker.probeFact('changed', 'greet.ts', ROUTES),
  walker.probeFact('remains', 'document the new commands', ROUTES),
  walker.probeFact('blocked', 'publish the release notes', ROUTES),
  walker.probeFact('proposed-next', 'continue the open deliverable', ROUTES),
  // The hermetic world pins the verify-evidence observation layer OFF, and a
  // resumed non-terminal run re-syncs verification from the LIVE owner — the
  // deterministic honest state here is 'unverified' (the fact is answered by
  // the state being VISIBLE; the seeded 'stale' can never survive the resync).
  // Calibrated with M3 — at the frozen baseline BOTH spellings were
  // not-visible (the kernel was empty on resume), so the baseline row stands.
  walker.probeFact('completion-evidence', 'checks: unverified', [{ cmd: '/run' }]),
]

// ── integrity: the seeded plan is intact and the chat's story reachable ─────
// The task board reads the process session, not the focused chat (blind to a
// resumed seed since the unified resume — the lead-queued terminal gap the
// parity prover names), so plan integrity pins on the DURABLE run itself and
// the operator's living inspection door is the prompts panel's receipt roll.
const sidecar = readRunSidecar(sid)
check(
  'the durable run holds the seeded plan (2 done · 1 in-progress · 2 open)',
  sidecar.snapshot.deliverables.filter(d => d.state === 'done').length === 2 &&
    sidecar.snapshot.deliverables.filter(d => d.state === 'in-progress').length === 1 &&
    sidecar.snapshot.deliverables.filter(d => d.state === 'open').length === 2,
)
const panel = walker.nav({ cmd: '/workbench' })
check("the prompts panel carries the chat's ask (the receipt roll)", hasProse(panel, 'Modernize the fixture demo'))

// ── report ──────────────────────────────────────────────────────────────────
const specialist = new Set<string>()
for (const f of facts) if (f.route) specialist.add(f.route)
const unanswered = facts.filter(f => f.visibility === 'not-visible').length
check('every walker capture painted (C3)', walker.failedCaptures.length === 0, walker.failedCaptures.join(' · '))

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
