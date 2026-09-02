#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-stop-hook-role.ts
//  PROOF (friction overhaul): the keep-working Stop hook is role-split. The
//  operator-facing SCRIBE may end a turn on a question to the operator (incl. an
//  open intake "What are we working on?") — NOT an unfinished tail. The
//  IMPLEMENTER (no human channel) still treats a trailing question as a stall.
//  Both still re-prompt on a promise/plan tail. The re-prompts are LEAK-PROOF
//  (never name the mechanism; instruct never to surface it).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-stop-hook-role.ts
// ============================================================================

import { isUnfinishedTail } from '../../src/utils/hooks/unfinishedTail.js'
import {
  SCRIBE_STOP_REPROMPT,
  IMPLEMENTER_STOP_REPROMPT,
} from '../../src/utils/hooks/scribeImplementerStopHook.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
// the two role calls
const scribe = (t: string) => isUnfinishedTail(t, { allowOperatorQuestion: true })
const impl = (t: string) => isUnfinishedTail(t)

console.log('============================================================')
console.log(' Stop-hook role split + leak-proof re-prompts — proof')
console.log('============================================================')

section('SCRIBE (operator-facing): a question to the operator is a VALID rest')
check('open intake "What are we working on?" ⇒ NOT unfinished', scribe('What are we working on?') === false)
check('plain operator question ⇒ NOT unfinished', scribe('Got it. Which file should I start with?') === false)
check('"Should I start with the parser?" ⇒ NOT unfinished', scribe('Should I start with the parser?') === false)
check('a promise/plan tail STILL re-prompts the Scribe', scribe("Recon done. I'll dispatch the refactor next.") === true)
check('a finished status ⇒ NOT unfinished', scribe('Dispatched. STATUS: in flight.') === false)
check('a pure tool turn (empty) ⇒ NOT unfinished', scribe('') === false)

section('SCRIBE wait-idiom exemption (scribe-flow fix): a passive "I\'ll wait" closer rests; a real promise still nudges')
// The keep-working hook must NOT spend its one Scribe block on a passive "I'll wait…" closer
// (the observed line-3 of the "test" dance), but the exemption must stay SOUND.
check('"I\'ll wait for your next message." ⇒ rest (line-3 backstop)', scribe("I'll wait for your next message.") === false)
check('"Sounds good. I\'ll be here." ⇒ rest', scribe('Sounds good. I\'ll be here.') === false)
check('"Hey — what are we building?" (carve-out reply) ⇒ rest', scribe('Hey — what are we building?') === false)
check('wait + a REAL promise ⇒ STILL nudges (sound, not over-exempted)', scribe("I'll wait — but first I'll dispatch the refactor and wire the gate.") === true)
check('a long wait tail (>140 chars) ⇒ NOT exempted (short-closer only)', scribe("I'll wait for your next message, and honestly there is a whole lot more i could say here to pad this out well beyond the short-closer threshold so it should not be exempt.") === true)
check('IMPLEMENTER "I\'ll wait…" ⇒ STILL a stall (no opts ⇒ byte-identical)', impl("I'll wait for your next message.") === true)

section('IMPLEMENTER (no human channel): a trailing question IS a stall')
check('"What are we working on?" ⇒ unfinished for the Implementer', impl('What are we working on?') === true)
check('a bare question ⇒ unfinished', impl('The config has two modes. Which one?') === true)
check('a structured option-bearing question is still allowed', impl('Scope — the whole map, or just this room?') === false)
check('a promise/plan tail ⇒ unfinished', impl("I'll wire up the gate next.") === true)
check('a finished status ⇒ NOT unfinished', impl('Wired the gate. Green-gate passing. STATUS: done.') === false)

section('re-prompts are LEAK-PROOF (internal-only, never name the mechanism)')
for (const [name, rp] of [['SCRIBE', SCRIBE_STOP_REPROMPT], ['IMPLEMENTER', IMPLEMENTER_STOP_REPROMPT]] as const) {
  check(`${name}: instructs never to mention/explain it`, /never mention|never .*explain/i.test(rp))
  check(`${name}: does NOT name "stop-rule"`, !/stop-rule/i.test(rp))
  check(`${name}: does NOT call itself a "hook"`, !/\bhook\b/i.test(rp))
  check(`${name}: still preserves the gate floor`, /never bypass a permission/i.test(rp))
}
check('SCRIBE re-prompt says "never make it its own turn"', /never make it its own turn/i.test(SCRIBE_STOP_REPROMPT))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL STOP-HOOK-ROLE PROOFS PASS')
else console.log(`❌ ${failures} STOP-HOOK-ROLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
