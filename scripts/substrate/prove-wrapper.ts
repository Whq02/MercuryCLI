#!/usr/bin/env bun

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

section('identity/honesty/safety FLOOR — content')
check('floor is a non-empty string', typeof MERCURY_IDENTITY_FLOOR === 'string' && MERCURY_IDENTITY_FLOOR.length > 0)
check('floor names Mercury', /Mercury/.test(MERCURY_IDENTITY_FLOOR))
check('session identity ends with its name before attribution', MERCURY_IDENTITY_FLOOR.startsWith('You are **Mercury** — this command-line coding harness and the agent running in it; the\nmodel is the engine. The one name you go by is Mercury.\nMercury was not built'))
check('closing identity states the engine and harness directly', MERCURY_IDENTITY_RECONCILE.includes('powers you is your engine, Mercury is what you are. Project docs'))
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

section('model-wake: getMercuryContractSections() — named sections, floor leads')
delete process.env.MERCURY_WRAPPER_APPEND
const secs = getMercuryContractSections()
check('returns 2 sections when the doctrine layer is on (no family overlay)', secs.length === 2, `len=${secs.length}`)
check('every section carries a semantic name + string text', secs.every(s => typeof s.name === 'string' && s.name.length > 0 && typeof s.text === 'string'))
check('section[0] is the identity floor (LEADS at model-wake)', secs[0]!.name === 'identity-floor' && secs[0]!.text === MERCURY_IDENTITY_FLOOR)
check('section[1] is the Mercury doctrine', secs[1]!.name === 'mercury-doctrine' && secs[1]!.text === MERCURY_DOCTRINE)
check('the closing reconcile fixes the brand to Mercury', /Mercury/.test(MERCURY_IDENTITY_RECONCILE))
check('no positional section names (semantic-ID law)', secs.every(s => !/^wrapper-\d|^mode-\d+$/.test(s.name)))

section('doctrine content: voice · autonomy · evidence, one owner each')
check('doctrine carries the voice clause (outcome-first close)', /outcome-first/.test(MERCURY_DOCTRINE))
check('doctrine carries the autonomy clause (never end on a promise)', /Before ending your turn/.test(MERCURY_DOCTRINE))
check('doctrine carries the evidence clause (audit claims against tool results)', /audit each claim against a tool result/.test(MERCURY_DOCTRINE))
check('doctrine carries the assessment-mode boundary', /deliverable is your assessment/.test(MERCURY_DOCTRINE))
check('voice: the tool-call line is a form rule, no second when-rule', /When a line introduces a tool call, keep it terse and present-tense\./.test(MERCURY_DOCTRINE) && !/only when it helps the operator follow/.test(MERCURY_DOCTRINE))
check('length: narration is skipped on short work alone, no read-only exemption', /Skip progress narration on short work unless state materially changed\./.test(MERCURY_DOCTRINE) && !/short or read-only work/.test(MERCURY_DOCTRINE))
check('evidence: reuse recorded evidence while it applies, recheck on change, memory is not verification', /Reuse recorded evidence while it still applies to the current state\. Recheck when relevant state changed, evidence is missing or stale, or new evidence contradicts it\. Memory alone is not verification\./.test(MERCURY_DOCTRINE) && !/verify recalled or remembered facts/.test(MERCURY_DOCTRINE))

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
