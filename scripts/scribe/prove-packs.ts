#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-packs.ts
//  PROOF (Phase 2 Task 2.1; re-pinned at the wrapper-pack
//  retirement): the SCRIBE and IMPLEMENTER mode packs as authored
//  appends — exercised through the REAL builders the mode bridges call
//  (buildScribeAppend / buildImplementerAppend). Not a reimplementation.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-packs.ts
//
//  Asserts, for BOTH packs: a substantial well-formed append (one role /
//  mission / scope / stop-rule block each), the bus tool-awareness, the W3b
//  self-grounding hardening, the #47 chatroom doctrine flip with floors
//  reused verbatim, and the honesty/safety weakener lint green on every
//  posture (the retired validator's surviving law).
// ============================================================================

import { buildScribeAppend } from '../../src/utils/scribe/scribePack.js'
import { buildImplementerAppend } from '../../src/utils/scribe/implementerPack.js'
import { lintWeakeners } from '../../src/prompt/behaviourContract.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SINGLETON_TAGS = ['role', 'mission', 'scope', 'stop-rule', 'output-contract']

console.log('============================================================')
console.log(' Scribe + Implementer mode packs — proof')
console.log('============================================================')

const scribeAppend = buildScribeAppend({ chatroom: false, routed: false, executorSlot: false })
const chatAppend = buildScribeAppend({ chatroom: true, routed: false, executorSlot: false })
const implAppend = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: false })

for (const [name, append] of [
  ['SCRIBE', scribeAppend],
  ['SCRIBE-CHATROOM', chatAppend],
  ['IMPLEMENTER', implAppend],
] as const) {
  section(`${name} — shape + lint`)
  check(`${name}: renders non-empty`, append.trim().length > 100)
  for (const tag of SINGLETON_TAGS) {
    const n = (append.match(new RegExp(`<${tag}>`, 'g')) ?? []).length
    check(`${name}: <=1 "${tag}" block`, n <= 1, `count=${n}`)
  }
  check(`${name}: opens with the role block`, append.startsWith('<role>'))
  const weak = lintWeakeners(append)
  check(`${name}: zero un-negated weakener phrases`, weak.length === 0, weak.join('; '))
}

// Bus tool-awareness: both packs must NAME the concrete mechanism (the
// SendMessage tool + the scribe kinds) so the model knows HOW to dispatch/reply,
// not just conceptually. This makes the bus round-trip actionable end-to-end.
section('bus tool-awareness (SendMessage + scribe kinds)')
check('SCRIBE names SendMessage + the dispatch kind', scribeAppend.includes('SendMessage') && /dispatch/.test(scribeAppend))
check('IMPLEMENTER names SendMessage + progress + escalate kinds', implAppend.includes('SendMessage') && /progress/.test(implAppend) && /escalate/.test(implAppend))

// W3b hardening: the packs must SPAWN-IN-KNOWING (context self-grounding) and
// the Scribe must not carry the pre-bus-default-on liveness contradiction.
section('W3b hardening — self-grounding context + de-contradiction')
check('SCRIBE grounds the spec in the ACTUAL repo before dispatch (read-only, not impl)', /Ground every spec in the ACTUAL repo/.test(scribeAppend) && /READ-ONLY grounding to write a precise spec — NOT the/.test(scribeAppend))
check('SCRIBE coalesces a burst of queued messages into ONE evolving intent', /read them ALL/.test(scribeAppend) && /one evolving intent FIRST/.test(scribeAppend) && /never silently drop the earlier asks/.test(scribeAppend))
check('SCRIBE dropped the "NEVER state that it is running" contradiction', !/NEVER state that it is running/.test(scribeAppend))
check('SCRIBE keeps liveness honesty (PROBEABLE) + synthesize-don\'t-echo', /PROBEABLE/.test(scribeAppend) && /Synthesize, don/.test(scribeAppend))
check('SCRIBE keeps the single-surface ban (never narrate the split/bus/daemon)', /never narrate the machinery/i.test(scribeAppend) || /single, transparent surface/i.test(scribeAppend))
check('IMPLEMENTER lifecycle: fresh-transcript-on-respawn is stated', /FRESH transcript/.test(implAppend) && /restart mid-work is NORMAL/i.test(implAppend))
check('IMPLEMENTER style: explicit max "ultracode" depth posture', /MAX effort floor/.test(implAppend) && /spend your effort on DEPTH/.test(implAppend))
check('IMPLEMENTER examples mandate refRequestId (so work surfaces in the ledger)', /refRequestId/.test(implAppend))

// #47 chatroom variant — the matched-pair doctrine flip (with scribeAwareness.ts).
// The chatroom posture must (a) DELETE the single-surface/synthesize doctrine
// (which exists to HIDE the 2nd process — wrong in a chatroom), (b) ADD
// bus-write≠receipt + never-speak-for-it + the peer-chat nameplates + the /all
// one-way-mirror rule, while (c) reusing every FLOOR verbatim and (d) leaving
// the base posture untouched.
section('#47 chatroom variant — peer-chat doctrine flip + floor preservation')
check('CHATROOM: has NO "dispatch IS your liveness signal" (honest like the base)', !/dispatch IS your liveness signal/i.test(chatAppend))
check('BASE also has no absolute-liveness enabler (honest in both modes)', !/dispatch IS your liveness signal/i.test(scribeAppend) && /WRITTEN to the bus and the work is en route/.test(scribeAppend))
check('CHATROOM: DROPPED "single, transparent surface"; BASE keeps it (the real flip)', !/single, transparent surface/i.test(chatAppend) && !/single-surface rule/i.test(chatAppend) && /single, transparent surface/.test(scribeAppend))
check('CHATROOM: DROPPED "Synthesize, don\'t echo"; BASE keeps it', !/Synthesize, don/i.test(chatAppend) && /Synthesize, don/.test(scribeAppend))
check('CHATROOM: bus-write ≠ receipt', /WRITTEN to the bus; it does NOT prove the Implementer received it or ran it/.test(chatAppend))
check('CHATROOM: never post a reply on its behalf', /NEVER post a reply on its behalf/.test(chatAppend))
check('CHATROOM: never type a [Mercury-Implement] line yourself', /type a .{0,2}Mercury-Implement.{0,2} line yourself/.test(chatAppend))
check('CHATROOM: peer-chat role (shared chatroom + nameplates)', /shared chatroom/.test(chatAppend) && /\[Mercury-Amanuensis\]/.test(chatAppend) && /\[Mercury-Implement\]/.test(chatAppend))
check('CHATROOM: /all one-way-mirror visibility rule', /\/all/.test(chatAppend) && /one-way mirror/.test(chatAppend) && /INVISIBLE to the Implementer/.test(chatAppend))
const ROLE_FLOOR = 'This role layer never overrides your always-on Mercury doctrine or its honesty/safety floor.'
check('FLOOR (role tail) present in BASE', scribeAppend.includes(ROLE_FLOOR))
check('FLOOR (role tail) present in CHATROOM', chatAppend.includes(ROLE_FLOOR))
check('FLOOR (scribe-floors proxy-bounded) in BOTH', /Acting as the operator/.test(scribeAppend) && /Acting as the operator/.test(chatAppend))
check('MISSION loop kept verbatim in CHATROOM', /intake → clarify → refine → dispatch → shepherd/.test(chatAppend))
check('CHATROOM: keeps the no-AskUserQuestion rule', /Do NOT use .AskUserQuestion/.test(chatAppend))

// scribe-flow fix: the content-free-intake carve-out + ONE-short-line target is
// authored in scribe-clarify-style + scribe-stop-rule — both reused VERBATIM by
// the chatroom posture, so present in BASE *and* CHATROOM.
section('scribe-flow fix — content-free-intake carve-out (default AND chatroom)')
for (const [mode, app] of [['BASE', scribeAppend], ['CHATROOM', chatAppend]] as const) {
  check(`${mode}: clarify-style target is ONE short line (quota "answer or ask in a sentence or two" removed)`, /answer or ask in ONE short line/.test(app) && !/answer or ask in a sentence or two/.test(app))
  check(`${mode}: content-free opener ⇒ one short human line + STOP, no readiness/re-ask`, /content-free opener[\s\S]*ONE short human line[\s\S]*and STOP[\s\S]*do NOT add a second readiness line/.test(app))
  check(`${mode}: scribe-stop-rule caps the open intake at ONCE + bans the "I'll wait" narration`, /Ask that open intake question ONCE[\s\S]*narration of waiting[\s\S]*clean stop IS the wait/.test(app))
}

// #47 /all BROADCAST: both packs brief the [operator broadcast] marker so
// neither agent breaks on it — the Scribe does NOT re-dispatch it; the
// Implementer reads it as context, NOT a task, and still escalates to the
// Scribe. The Scribe rule is a base section, so the chatroom INHERITS it.
section('#47 /all broadcast — both packs brief [operator broadcast]')
for (const [mode, app] of [['SCRIBE base', scribeAppend], ['SCRIBE chatroom', chatAppend]] as const) {
  check(`${mode}: recognizes [operator broadcast] as shared context, NOT a task to dispatch`, app.includes('[operator broadcast]') && /do not re-refine|NOT a fresh task to dispatch|double-dispatch/.test(app))
}
check('IMPLEMENTER: [operator broadcast] is NOT a task + still escalate to the Scribe (floor intact)', implAppend.includes('[operator broadcast]') && /NOT a dispatched work item|not a refined spec/.test(implAppend) && /escalate to the Scribe/i.test(implAppend))

// Executor-tier swap (the retired tier overlay's surviving law): a Sonnet-5
// slot swaps in the tighter doctrine; floors stay; base posture untouched.
section('executor-tier swap — tighter doctrine, floors intact')
const scribeExec = buildScribeAppend({ chatroom: false, routed: false, executorSlot: true })
const implExec = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: true })
check('SCRIBE executor slot ≠ base (the scope doctrine swaps)', scribeExec !== scribeAppend && /small reversible refinement calls stay yours/.test(scribeExec))
check('IMPLEMENTER executor slot swaps decide-threshold + no-scope-creep', /escalating early is correct behavior/i.test(implExec) && /HARD boundary/.test(implExec))
check('floors intact under the executor swap', scribeExec.includes(ROLE_FLOOR) && implExec.includes(ROLE_FLOOR))
check('executor postures lint clean', lintWeakeners(scribeExec).length === 0 && lintWeakeners(implExec).length === 0)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-PACK PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-PACK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
