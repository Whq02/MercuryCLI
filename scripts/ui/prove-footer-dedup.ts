// ============================================================================
//  prove-footer-dedup — CommandCenter close-hint de-duplication.
//
//  composeFooterHint appends a close hint ONLY when the footer doesn't already
//  advertise one. Proves:
//   • non-close footers are byte-identical to the pre-fix append (no regression)
//   • the 5 captureInput=false callers that bake a close synonym get NO append
//   • the SessionManagerView empty-state ('… esc / ← close') gets NO append
//   • a 'close' word with no esc/← token does NOT false-trigger the de-dup
// ============================================================================
import { composeFooterHint, footerAdvertisesClose } from '../../src/components/mercury-ui/footerHint.js'

let fail = 0
function eq(label: string, got: string, want: string): void {
  const ok = got === want
  if (!ok) fail++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) console.log(`         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`)
}
function is(label: string, got: boolean, want: boolean): void {
  const ok = got === want
  if (!ok) fail++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('── byte-identical for footers with NO close token ──')
// captureInput=true, closeKeys default → ' · esc / ← close'
eq('shell footer (captureInput, esc-arrow) → esc / ← close',
  composeFooterHint('↑↓ select · ↵ switch', { closeKeys: 'esc-arrow', captureInput: true }),
  '↑↓ select · ↵ switch · esc / ← close')
// captureInput=false → ' · esc close'
eq('captureInput=false → esc close',
  composeFooterHint('↑↓ select · ↵ switch', { closeKeys: 'esc-arrow', captureInput: false }),
  '↑↓ select · ↵ switch · esc close')
// closeKeys='esc' forces esc-only even with captureInput
eq("closeKeys='esc' → esc close",
  composeFooterHint('↑↓ move', { closeKeys: 'esc', captureInput: true }),
  '↑↓ move · esc close')
// cwd fallback (footer undefined → caller passes dir)
eq('bare dir base + append',
  composeFooterHint('orchard-src', { closeKeys: 'esc-arrow', captureInput: true }),
  'orchard-src · esc / ← close')

console.log('\n── de-dup fires for the 5 HB-0216 baked footers (no append) ──')
const baked: Array<[string, string]> = [
  ['CapabilityDetailView (cleaned)', '↑↓ select · ←→/tab switch tab · read-only'],
  ['AutoDefaultNudge', '↑↓ choose · enter select · esc keep'],
  ['AutoDefaultNotice', 'enter / esc dismiss'],
  ['/copy', 'enter copy · w write to file · esc cancel'],
]
for (const [name, f] of baked) {
  // CapabilityDetailView (cleaned) has NO close token now → it SHOULD append.
  if (name.includes('cleaned')) {
    eq(`${name} → CommandCenter supplies esc close`,
      composeFooterHint(f, { closeKeys: 'esc', captureInput: false }),
      f + ' · esc close')
  } else {
    eq(`${name} → no append (synonym already present)`,
      composeFooterHint(f, { closeKeys: 'esc', captureInput: false }),
      f)
  }
}

console.log('\n── HB-0205 SessionManagerView (both variants bake esc / ← close) ──')
eq('empty-state → no append',
  composeFooterHint('n new · esc / ← close', { closeKeys: 'esc-arrow', captureInput: false }),
  'n new · esc / ← close')
eq('populated → no append (honest ← kept)',
  composeFooterHint('↑↓ select · ↵ switch · n new · esc / ← close', { closeKeys: 'esc-arrow', captureInput: false }),
  '↑↓ select · ↵ switch · n new · esc / ← close')

console.log('\n── DEFER-shaped surfaces (the party consent card) ──')
is("'esc later' advertises close (defer synonym)", footerAdvertisesClose('a approve · d deny · esc later'), true)
eq('consent-card footer → no contradictory esc-close append',
  composeFooterHint('a approve · h high · l low · d deny · c clarify · ↵ detail · esc later', { closeKeys: 'esc', captureInput: false }),
  'a approve · h high · l low · d deny · c clarify · ↵ detail · esc later')

console.log('\n── FILTER-shaped surfaces (first esc clears the query) ──')
is("'esc clears the filter' advertises the esc action (clear synonym)",
  footerAdvertisesClose('↵ open · esc clears the filter'), true)
eq('/manager filtering footer → no contradictory esc-close append',
  composeFooterHint('↵ open · esc clears the filter', { closeKeys: 'esc', captureInput: false }),
  '↵ open · esc clears the filter')
eq('memory-centre query footer → no doubled tail (the pre-fix contradiction)',
  composeFooterHint('↑↓ move · ↵ inspect · esc clear', { closeKeys: 'esc', captureInput: false }),
  '↑↓ move · ↵ inspect · esc clear')

console.log('\n── no false-positive ──')
is("'close the deck' (no esc/← token) does NOT advertise close", footerAdvertisesClose('close the deck'), false)
is("'esc' alone (no synonym) does NOT advertise close", footerAdvertisesClose('press esc'), false)
is("cross-segment 'esc · … close' does NOT match (scoped to segment)", footerAdvertisesClose('esc here · open the close panel'), false)
is("'← close' advertises close", footerAdvertisesClose('n new · ← close'), true)
eq("'close the deck' still gets the append",
  composeFooterHint('close the deck', { closeKeys: 'esc', captureInput: false }),
  'close the deck · esc close')

console.log('\n════════════════════════════════════════════════════════════')
if (fail === 0) {
  console.log('✅ ALL FOOTER-DEDUP PROOFS PASS')
} else {
  console.log(`❌ ${fail} FOOTER-DEDUP CHECK(S) FAILED`)
  process.exit(1)
}
