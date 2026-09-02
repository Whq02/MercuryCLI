#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-brief-reconcile.ts
//  PROOF (Phase 1 of the friction-study spec): the brief-mode ↔ scribe
//  reconciliation that fixes the "end-of-session error" (#22) — a behavioral
//  dead-end, NOT a crash. Three interlocking fixes:
//   (1) the Scribe pack now NAMES SendUserMessage as the operator channel +
//       steers off AskUserQuestion + teaches bus-write-is-not-receipt: a successful
//       send means written-to-bus + en-route (so a not-yet reply is NOT a failure —
//       kills the "something's wrong on my end" panic + 2-min dead-air) but is NOT
//       proof of receipt (so never narrate/invent a reply — kills the fabrication,
//       #47). The pre-#47 "dispatch IS your liveness signal" was that fabrication's
//       own enabler; it is replaced, in both the static pack and the dynamic reminder;
//   (2) brief mode is denied to the Implementer (no human channel) — kills the
//       recurring nudge at the isBriefEntitled choke;
//   (3) usedBrief credits AskUserQuestion + a Scribe bus-dispatch as a satisfied
//       turn (stops the double/triple nag).
//  Unloadable modules (stopHooks/BriefTool reach feature()/require) are asserted
//  structurally per the bun-run-loadability note; the pure helper is exercised live.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-brief-reconcile.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const aware = (await import('../../src/utils/scribe/scribeAwareness.js')) as typeof import('../../src/utils/scribe/scribeAwareness.js')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

console.log('============================================================')
console.log(' Brief-mode ↔ scribe reconciliation (#22 fix) — proof')
console.log('============================================================')

section('(3) briefTurnSatisfiedByScribeBus — a Scribe bus action satisfies the turn')
const dispStructured = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'implementer', message: { type: 'dispatch', task: 'do the thing' } } }] } }
const dispString = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'implementer', message: bus.serializeScribeEnvelope(bus.buildDispatch('scribe', 'do the thing', { title: 'T' })) } }] } }
const escString = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'scribe', message: bus.serializeScribeEnvelope(bus.buildEscalate('implementer', 'blocked')) } }] } }
const prose = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll relay that back to you." }] } }
const otherTool = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
check('structured {message:{type:dispatch}} ⇒ satisfied', aware.briefTurnSatisfiedByScribeBus([dispStructured]) === true)
check('serialized dispatch string ⇒ satisfied', aware.briefTurnSatisfiedByScribeBus([dispString]) === true)
check('serialized escalate string ⇒ satisfied', aware.briefTurnSatisfiedByScribeBus([escString]) === true)
check('plain prose ("I\'ll relay") ⇒ NOT satisfied (would be nagged)', aware.briefTurnSatisfiedByScribeBus([prose]) === false)
check('a non-bus tool (Bash) ⇒ NOT satisfied', aware.briefTurnSatisfiedByScribeBus([otherTool]) === false)
check('empty ⇒ NOT satisfied', aware.briefTurnSatisfiedByScribeBus([]) === false)

section('(1) Scribe pack: names SendUserMessage, steers off AskUserQuestion, bus-write≠receipt')
const pack = src('utils', 'scribe', 'scribePack.ts')
check('pack NAMES SendUserMessage as the operator channel', /SendUserMessage/.test(pack))
check('pack steers OFF AskUserQuestion as the operator channel', /AskUserQuestion/.test(pack) && /not your.*single transparent surface|do not use `AskUserQuestion`/i.test(pack))
// #47: the old "dispatch IS your liveness signal" (the fabrication enabler) is REPLACED with
// the honest pair — written-to-bus + en-route (anti-panic) but NOT proof-of-receipt (anti-fabrication).
check('pack: a successful send is WRITTEN to the bus + en route (anti-panic)', /WRITTEN to the bus and the work is en route/.test(pack))
check('pack: a pending reply is NOT a failure', /NOT a failure/i.test(pack))
check('pack: a send is NOT proof of receipt — never invent a reply (anti-fabrication)', /NOT proof the Implementer received it/.test(pack) && /never narrate, summarize, claim, or invent its progress or a/.test(pack))
check('pack: the pre-#47 "dispatch IS your liveness signal" enabler is GONE', !/dispatch IS your liveness signal/i.test(pack))
check('pack: TeamBrief "not part of a team" is expected, not a fault', /EXPECTED for you/i.test(pack) && /TeamBrief/.test(pack))

section('(1) scribeAwareness bus-live branch is honest (bus-write≠receipt) (+ gate-off byte-identical)')
const awareSrc = src('utils', 'scribe', 'scribeAwareness.ts')
check('bus-live branch: written-to-bus, not proof-of-receipt', /WRITTEN to the bus; it does NOT prove an/.test(awareSrc) && /Implementer received it or ran it/.test(awareSrc))
check('bus-live branch: never narrate/summarize/claim/invent an Implementer reply (anti-fabrication)', /NEVER narrate, summarize, claim, or invent an Implementer reply/.test(awareSrc))
check('bus-live branch: do not invent a failure on a genuine send (anti-panic)', /do not invent a failure when a send/.test(awareSrc))
check('bus-live branch: the pre-#47 "dispatch IS your liveness signal" enabler is GONE', !/dispatch IS your\s*\n?\s*.{0,40}liveness signal/i.test(awareSrc))
check('gate-off ⇒ buildScribeAwarenessReminder([]) === "" (byte-identical, no attachment)', aware.buildScribeAwarenessReminder([]) === '')

section('(2) brief denied to the Implementer (isBriefEntitled early-return)')
const brief = src('tools', 'BriefTool', 'BriefTool.ts')
check('isBriefEntitled returns false for the Implementer', /if \(isImplementerRole\(\)\) return false/.test(brief))
check('imports isImplementerRole', /import \{[^}]*\bisImplementerRole\b[^}]*\} from '\.\.\/\.\.\/utils\/scribe\/scribeGates/.test(brief))

section('(2)+(3) stopHooks wiring: Implementer guard + AskUserQuestion + bus-dispatch credit')
const sh = src('query', 'stopHooks.ts')
check('brief guard excludes the Implementer (defense-in-depth)', /if \(scribeGates\.isImplementerRole\(\)\) return/.test(sh))
check('usedBrief credits AskUserQuestion', /ASK_USER_QUESTION_TOOL_NAME/.test(sh))
check('calledBrief credits a Scribe bus dispatch (no double-nag)', /scribeGates\.scribeModeEnabled\(\)[\s\S]{0,80}engage\.isScribeSessionPinned\(\)/.test(sh) && /SEND_MESSAGE_TOOL_NAME/.test(sh))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BRIEF-RECONCILE PROOFS PASS')
else console.log(`❌ ${failures} BRIEF-RECONCILE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
