#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-wrapper.ts
//  PROOF: the ALWAYS-ON Mercury behavioural contract applies at MODEL-WAKE (as
//  system-prompt SECTIONS, never as follow-up messages on top of a legacy
//  prompt) and its identity/honesty/safety FLOOR is toggle-independent — it
//  ships even with the doctrine layer off, and can never be toggled away.
//  Exercised against the REAL production module src/prompt/mercuryContract.ts
//  (no reimpl). Since the contract is repository-owned source —
//  every section carries a stable semantic name.
//
//  This locks the invariants getSystemPrompt() relies on (prompts.ts composes
//  getMercuryContractSections() INTO the system array — model-wake): the floor
//  LEADS the contract, the doctrine follows only when the layer is on, no
//  family-scoped section exists (the one-content law — proven wire-side in
//  scripts/model-routing/prove-behaviour-contract.ts), and the floor is
//  present in BOTH the doctrine-on and doctrine-off paths.
// ============================================================================

import {
  MERCURY_DOCTRINE,
  MERCURY_IDENTITY_FLOOR,
  MERCURY_IDENTITY_RECONCILE,
  getMercuryContractSections,
  mercuryDoctrineEnabled,
} from '../../src/prompt/mercuryContract.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Mercury contract — model-wake + always-on-floor proof')
console.log('============================================================')

// ── the floor states identity + operator-first + the honesty/safety boundary ──
section('identity/honesty/safety FLOOR — content')
check('floor is a non-empty string', typeof MERCURY_IDENTITY_FLOOR === 'string' && MERCURY_IDENTITY_FLOOR.length > 0)
check('floor names Mercury', /Mercury/.test(MERCURY_IDENTITY_FLOOR))
check('floor states operator-first', /OPERATOR FIRST|operator/i.test(MERCURY_IDENTITY_FLOOR))
check(
  'floor states the honesty/safety boundary (no deceive / no gate-bypass)',
  /don't deceive|bypass a real safety, permission, or/i.test(MERCURY_IDENTITY_FLOOR),
)
check(
  'floor is provider-neutral (no model-family identity — cross-provider law)',
  !/Claude|Anthropic|GPT|OpenAI/.test(MERCURY_IDENTITY_FLOOR),
)
check('floor precedence tie-break present', /safety and honesty first, then the operator, then defaults/.test(MERCURY_IDENTITY_FLOOR))

// ── model-wake: sections, floor leads, doctrine on, one content ───────────────
section('model-wake: getMercuryContractSections() — named sections, floor leads')
delete process.env.MERCURY_WRAPPER_APPEND
const secs = getMercuryContractSections()
check('returns 2 sections when the doctrine layer is on (no family overlay)', secs.length === 2, `len=${secs.length}`)
check('every section carries a semantic name + string text', secs.every(s => typeof s.name === 'string' && s.name.length > 0 && typeof s.text === 'string'))
check('section[0] is the identity floor (LEADS at model-wake)', secs[0]!.name === 'identity-floor' && secs[0]!.text === MERCURY_IDENTITY_FLOOR)
check('section[1] is the Mercury doctrine', secs[1]!.name === 'mercury-doctrine' && secs[1]!.text === MERCURY_DOCTRINE)
check('no family-scoped section exists (the one-content law)', secs.every(s => s.name !== 'gpt-developer-contract'))
check('the closing reconcile fixes the brand to Mercury', /Mercury/.test(MERCURY_IDENTITY_RECONCILE))
check('no positional section names (semantic-ID law)', secs.every(s => !/^wrapper-\d|^mode-\d+$/.test(s.name)))

// ── doctrine content sanity ───────────────────────────────────────────────────
section('doctrine content: voice · autonomy · evidence, one owner each')
check('doctrine carries the voice clause (outcome-first close)', /outcome-first/.test(MERCURY_DOCTRINE))
check('doctrine carries the autonomy clause (never end on a promise)', /Before ending your turn/.test(MERCURY_DOCTRINE))
check('doctrine carries the evidence clause (audit claims against tool results)', /audit each claim against a tool result/.test(MERCURY_DOCTRINE))
check('doctrine carries the assessment-mode boundary', /deliverable is your assessment/.test(MERCURY_DOCTRINE))
check(
  'doctrine references NO retired wrapper machinery',
  !new RegExp([['Temp', 'est Desert'].join(''), ['temp', 'est_coord'].join(''), 'coord\\.mjs', 'TF_REPO_ID', 'lease'].join('|')).test(MERCURY_DOCTRINE),
)

// ── the doctrine gate (the floor is independent of it) ────────────────────────
section('doctrine gate: MERCURY_WRAPPER_APPEND=0 opts out the DOCTRINE, never the floor')
delete process.env.MERCURY_WRAPPER_APPEND
check('default ⇒ doctrine layer ON', mercuryDoctrineEnabled() === true)
process.env.MERCURY_WRAPPER_APPEND = '0'
check('MERCURY_WRAPPER_APPEND=0 ⇒ doctrine OFF (opt-out)', mercuryDoctrineEnabled() === false)
const offSecs = getMercuryContractSections()
check('doctrine section absent when off', !offSecs.some(s => s.name === 'mercury-doctrine'))
check('floor SURVIVES the opt-out (always-on guarantee)', offSecs[0]!.name === 'identity-floor' && offSecs[0]!.text === MERCURY_IDENTITY_FLOOR)
delete process.env.MERCURY_WRAPPER_APPEND

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CONTRACT PROOFS PASS (model-wake + always-on floor)')
else console.log(`❌ ${failures} CONTRACT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
