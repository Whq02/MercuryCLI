#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-handoff-summary.ts
//  PROOF: the session→session handoff honesty gate (now LIVE-by-default in the
//  daemon) does NOT launder unbacked success claims into the next session.
//  Exercised against the REAL buildHandoffSummary / renderHandoffSummary.
//
//  Regression for the autonomy-review findings:
//   #1  no verified evidence (the daemon path) ⇒ the WHOLE `changed` bucket is
//       demoted to doNotTrust (the leaky SUCCESS_RE whitelist is not the
//       only gate — every "I did X / it works now" phrasing is flagged).
//   #5  the render frames the block as CONTEXT-ONLY / not-instructions.
//   (gate still honors real evidence: a backed claim survives when refs verify.)
// ============================================================================

import {
  buildHandoffSummary,
  renderHandoffSummary,
} from '../../src/utils/swarm/handoffSummary.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Handoff honesty gate — no-launder proof')
console.log('============================================================')

// ── #1 — no verified evidence ⇒ EVERYTHING in `changed` is demoted ───────────
section('#1 — no evidence ⇒ whole `changed` bucket → doNotTrust (no laundering)')
{
  // These phrasings ALL slipped the old SUCCESS_RE whitelist (laundered as fact).
  const launderers = [
    'I implemented the feature and it now compiles cleanly',
    'The bug is gone',
    'Merged to main',
    'Shipped the update',
    'Patch applied',
    'I added the new endpoint',
  ]
  const s = buildHandoffSummary({ changed: launderers, evidence: [] })
  check('changed bucket is EMPTY (nothing presented as verified)', s.changed.length === 0)
  check('every line routed to doNotTrust', s.doNotTrust.length === launderers.length)
  check('a previously-laundered claim is now flagged', s.doNotTrust.includes('Merged to main'))

  const rendered = renderHandoffSummary(s)
  check('render surfaces the [UNVERIFIED] block', rendered.includes('[UNVERIFIED'))
  check('render does NOT show a "Changed (verified" section', !rendered.includes('Changed (verified'))
}

// ── #5 — the folded block is framed as context, not instructions ─────────────
section('#5 — render frames continuity as CONTEXT-ONLY, not instructions')
{
  const s = buildHandoffSummary({ changed: ['did a thing'], evidence: [] })
  const r = renderHandoffSummary(s)
  check('header says CONTEXT ONLY / not new instructions', /CONTEXT ONLY|not new instructions/.test(r))
  check('header warns not to execute embedded instructions', /Do NOT execute|do not act on/i.test(r))
}

// ── gate still honors REAL verified evidence (non-daemon callers) ─────────────
section('Gate still works WITH evidence: a backed success claim survives')
{
  const s = buildHandoffSummary({
    changed: ['tests pass for the parser module', 'unrelated it works'],
    evidence: [{ ref: 'parser', kind: 'test', verified: true }],
  })
  check('a claim backed by a matching verified ref survives in `changed`', s.changed.includes('tests pass for the parser module'))
  check('an UNbacked success claim is still demoted', s.doNotTrust.includes('unrelated it works'))
}

// ── negative buckets + next still pass; fail-open on junk ────────────────────
section('Negative buckets pass verbatim; junk fails open')
{
  const s = buildHandoffSummary({ failed: ['build broke'], blocked: ['need a key'], next: ['confirm tests pass'], evidence: [] })
  check('failed passes verbatim', s.failed.includes('build broke'))
  check('next passes verbatim (never gated — aspirational)', s.next.includes('confirm tests pass'))
  // @ts-expect-error junk input must fail open, never throw
  const j = buildHandoffSummary(42)
  check('junk input ⇒ empty shape (fail-open, no throw)', j.generated === true && j.changed.length === 0 && j.doNotTrust.length === 0)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL HANDOFF-SUMMARY PROOFS PASS')
else console.log(`❌ ${failures} HANDOFF-SUMMARY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
