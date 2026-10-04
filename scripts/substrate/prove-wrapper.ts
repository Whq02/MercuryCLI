#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MERCURY_IDENTITY_FLOOR,
  MERCURY_IDENTITY_RECONCILE,
  MERCURY_SESSION_CONTRACT,
  MERCURY_SESSION_DOCTRINE,
  getMercuryContractSections,
  mercuryDoctrineEnabled,
} from '../../src/prompt/mercuryContract.js'

const STATIC_HEAD = readFileSync(join(import.meta.dir, '..', '..', 'src/constants/prompts.ts'), 'utf8')

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
check('section[1] is the Mercury doctrine: the session contract inside its tag', secs[1]!.name === 'mercury-doctrine' && secs[1]!.text === MERCURY_SESSION_DOCTRINE && MERCURY_SESSION_DOCTRINE === `<mercury-doctrine>\n${MERCURY_SESSION_CONTRACT}\n</mercury-doctrine>`)
check('the closing reconcile fixes the brand to Mercury', /Mercury/.test(MERCURY_IDENTITY_RECONCILE))
check('no positional section names (semantic-ID law)', secs.every(s => !/^wrapper-\d|^mode-\d+$/.test(s.name)))

section('session contract content: voice · autonomy · evidence · ending the turn; the mechanics stay with the static head (one owner each)')
check('contract carries the voice clause (open on the read or the move, close outcome first with the evidence named)', /Open on what you found or what you are about to do, never on a pleasantry or a restatement of the request/.test(MERCURY_SESSION_CONTRACT) && /close with the outcome first/.test(MERCURY_SESSION_CONTRACT) && /one line naming the evidence you verified/.test(MERCURY_SESSION_CONTRACT))
check('contract carries the autonomy clause (act with enough information, name the assumption, stop only for the destructive, a scope change or operator-only input)', /With enough information, act and name any assumption you made/.test(MERCURY_SESSION_CONTRACT) && /stopping only for a destructive act, a real scope change or input only the operator can give/.test(MERCURY_SESSION_CONTRACT))
check('contract carries the assessment-mode boundary', /describes a problem rather than asking for a change, assess and stop/.test(MERCURY_SESSION_CONTRACT))
check('contract carries the evidence clause (claims only from this session\'s tool results; name what is not verified)', /Claim only what a tool result from this session shows, name what is not verified/.test(MERCURY_SESSION_CONTRACT))
check('contract carries the persistence clause (keep going while evidence advances; never wind down because the session is long)', /keep going while evidence advances the outcome, never winding down because the session is long/.test(MERCURY_SESSION_CONTRACT))
check('contract carries the last-paragraph check (never end on a plan, a promise or a self-answerable question)', /Before ending your turn, check your last paragraph and do now any work it only plans, promises or asks about/.test(MERCURY_SESSION_CONTRACT))
check('contract carries the idle rule (end the turn when the work settles or when told to idle; no sleeps or timers)', /end the turn when the work settles or when told to idle, never holding it open with sleeps or timers/.test(MERCURY_SESSION_CONTRACT))
check('the tool-call working note, the quick-task preamble rule and the evidence-reuse condition stay with the static head alone (one owner)', !/tool call|narration|appendix|reuse/.test(MERCURY_SESSION_CONTRACT) && STATIC_HEAD.includes('Text written before a tool call is a one-line working note about the next step') && STATIC_HEAD.includes('Skip preambles for quick tasks') && STATIC_HEAD.includes('on the rare occasion process or reasoning must appear, put it at the end') && STATIC_HEAD.includes('no re-verifying what was already checked while its evidence still applies to the current state'))
check('the brevity preference stays with the floor alone (one owner)', !/brevity/.test(MERCURY_SESSION_CONTRACT) && /Follow their stated preferences ahead of generic defaults/.test(MERCURY_IDENTITY_FLOOR))

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
