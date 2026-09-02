#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-awareness.ts
//  PROOF (W3c): the per-turn Scribe awareness <system-reminder>.
//   (a) GATE: scribeModeEnabled() && isScribeModeOn() && !isImplementerRole() — OFF
//       (bare-stamp, scribe mode not engaged, MERCURY_SCRIBE_MODE=0, or the Implementer
//       process) ⇒ '' ⇒ no attachment ⇒ byte-identical. (Gates on the MODE, not the
//       role env, so the /model carousel engage — which never sets MERCURY_SCRIBE — works.)
//   (b) ON: non-empty; carries the role/single-surface line + the closing floor.
//   (c) bus-live branch: MERCURY_SCRIBE_BUS_LIVE on ⇒ the honest bus-write≠receipt
//       doctrine (#47: a send is WRITTEN to the bus, NOT proof of receipt — never
//       invent a reply); =0 ⇒ "live bus is off" (honest, never claim work underway).
//   (d) ledger: empty ⇒ "no work has been dispatched"; a real dispatch fixture ⇒
//       a "[dispatched] <title>" row (derived from buildScribeLedger, the deck's
//       own pure helper — byte-consistent with the UI).
//   (e) wiring: the scribe_awareness Attachment member + producer + maybe()
//       registration (attachments.ts), the normalizeAttachmentForAPI case
//       (messages.ts), and NULL_RENDERING_TYPES (operator-invisible).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-awareness.ts
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildScribeAwarenessReminder } from '../../src/utils/scribe/scribeAwareness.js'
import { setScribeMode } from '../../src/utils/scribeMode.js'
import { buildDispatch, serializeScribeEnvelope } from '../../src/utils/scribe/scribeBus.js'
import {
  publishImplementerTelemetry,
  __resetImplementerTelemetryForTests,
} from '../../src/utils/scribe/implementerTelemetry.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

// A real dispatch fixture, serialized the way useInboxPoller stores it.
const dispatchMsg = {
  type: 'user',
  message: { role: 'user', content: serializeScribeEnvelope(buildDispatch('scribe', 'Implement Task X with TDD', { title: 'Task X' })) },
}

console.log('============================================================')
console.log(' Scribe awareness reminder (W3c) — gate + content + wiring')
console.log('============================================================')

section('(a) GATE — OFF ⇒ "" ⇒ byte-identical')
// output is stamp-independent (equality probe).
setStamp(false)
setScribeMode(true)
const bareStamped = buildScribeAwarenessReminder([])
setStamp(true)
check('stamp-independence: bare-stamped output === full-stamped output', bareStamped === buildScribeAwarenessReminder([]))
setScribeMode(false)
check('fork but scribe mode NOT engaged ⇒ ""', buildScribeAwarenessReminder([]) === '')
setScribeMode(true)
process.env.MERCURY_SCRIBE_MODE = '0'
check('scribe mode opted out (MERCURY_SCRIBE_MODE=0) ⇒ ""', buildScribeAwarenessReminder([]) === '')
delete process.env.MERCURY_SCRIBE_MODE
process.env.MERCURY_IMPLEMENTER = '1'
check('the Implementer process ⇒ "" (gets implementerAwareness, never this — XOR guard)', buildScribeAwarenessReminder([]) === '')
delete process.env.MERCURY_IMPLEMENTER

section('(b) ON — role + single-surface + closing floor')
setScribeMode(true) // fork + scribe mode engaged (the gate lever, not the role env)
// The chatroom is default-ON now — pin =0 so (b)+(c) test the
// single-surface variant explicitly (the #47 section below flips it back to '1').
process.env.MERCURY_SCRIBE_CHATROOM = '0'
delete process.env.MERCURY_SCRIBE_BUS_LIVE
const on = buildScribeAwarenessReminder([])
check('ON ⇒ non-empty', on.length > 0)
check('names the Scribe + single-surface ban', /You are the Scribe/.test(on) && /never narrate the two-process split/.test(on))
check('closes on the proxy/gate floor', /never licenses bypassing a permission/.test(on))
// Leak needles cover the CURRENT seat ids (fable-5/opus-5) AND the historical
// opus-4-8 pin — the check must not go vacuous when the seats repin.
check('does NOT leak a model id / effort to the operator', !/opus-4-8|opus-5|fable-5/.test(on) && !/xhigh/.test(on))

section('(c) bus-live branch')
delete process.env.MERCURY_SCRIBE_BUS_LIVE
const busLive = buildScribeAwarenessReminder([])
// #47: the honest doctrine replaced the pre-#47 "default posture / dispatch IS liveness".
check('bus live (default) ⇒ a send is WRITTEN to the bus (not proof of receipt)', /a successful send means the message was WRITTEN to the bus/.test(busLive))
check('bus live (default) ⇒ never narrate/claim/invent an Implementer reply', /NEVER narrate, summarize, claim, or invent an Implementer reply/.test(busLive))
check('bus live (default) ⇒ the pre-#47 "dispatch IS your liveness signal" is GONE', !/dispatch IS your liveness signal/i.test(busLive))
// scribe-flow fix: the dispatch+ack imperative is CONDITIONAL on actionable intent, with an
// explicit empty-turn carve-out — this is what stops the bare-"test" ack-after-ack cascade.
check('bus live ⇒ dispatch imperative is CONDITIONAL on actionable intent', /When the operator hands you ACTIONABLE intent/.test(busLive))
check('bus live ⇒ empty/greeting turn ⇒ ONE short line + STOP, no second ack', /NOTHING to dispatch yet[\s\S]*ONE short line and STOP[\s\S]*do NOT[\s\S]*emit another ack/.test(busLive))
check('footer: open intake asked ONCE; clean stop is the wait (no readdress license)', /asked once[\s\S]*valid resting point[\s\S]*clean stop with no follow-up readiness line/.test(buildScribeAwarenessReminder([])))
process.env.MERCURY_SCRIBE_BUS_LIVE = '0'
const busOff = buildScribeAwarenessReminder([])
check('bus off (=0) ⇒ "live bus is off"', /The live bus is off this session/.test(busOff))
check('bus off stays honest (no fake work underway)', /never claim work is underway when it is not/.test(busOff))
check('bus off ⇒ ALSO carries the empty-intake carve-out (symmetry with bus-live)', /nothing to act on yet[\s\S]*ONE short line and STOP/.test(busOff))
delete process.env.MERCURY_SCRIBE_BUS_LIVE

section('(c2) MID-TASK elapsed + stall — Scribe time-awareness')
// the telemetry block is gated on bus-live (default ON for the fork); publish a
// distilled telemetry the way the foreground poll does, then read the rendered line.
delete process.env.MERCURY_SCRIBE_BUS_LIVE
publishImplementerTelemetry({ daemonUp: true, present: true, busy: true, turnElapsedMs: 8 * 60_000 })
const busy8 = buildScribeAwarenessReminder([])
check('busy 8m ⇒ "MID-TASK for ~8m" (time-aware, no longer blind)', /MID-TASK for ~8m/.test(busy8))
check('busy 8m ⇒ normal guidance ("not stuck just because a reply")', /not stuck just because a reply/.test(busy8))
check('busy 8m ⇒ NOT flagged wedged', !/may be wedged/.test(busy8))
publishImplementerTelemetry({ daemonUp: true, present: true, busy: true, turnElapsedMs: 12 * 60_000 })
const busy12 = buildScribeAwarenessReminder([])
check('busy 12m (past stall) ⇒ "MID-TASK for ~12m"', /MID-TASK for ~12m/.test(busy12))
check('busy 12m ⇒ flips to UNUSUALLY long / may be wedged', /UNUSUALLY long/.test(busy12) && /may be wedged/.test(busy12))
check('busy 12m ⇒ stays honest (do NOT claim finished / invent a reply)', /do NOT claim it finished, invent a reply/.test(busy12))
check('busy 12m ⇒ DROPS the reassuring "not stuck" line (it MIGHT be stuck now)', !/not stuck just because a reply/.test(busy12))
publishImplementerTelemetry({ daemonUp: true, present: true, busy: true })
const busyNoClock = buildScribeAwarenessReminder([])
check('busy w/o turn clock ⇒ MID-TASK, no "for ~", normal guidance (back-compat)', /is MID-TASK/.test(busyNoClock) && !/for ~/.test(busyNoClock) && /not stuck just because/.test(busyNoClock))
publishImplementerTelemetry({ daemonUp: true, present: true, busy: false, turnElapsedMs: 99 * 60_000 })
const idleT = buildScribeAwarenessReminder([])
check('idle ⇒ IDLE, no elapsed/stall (even with a stale clock)', /is IDLE/.test(idleT) && !/MID-TASK/.test(idleT) && !/may be wedged/.test(idleT))
check('the poll copies turnElapsedMs from the wire entry', /turnElapsedMs: e\.turnElapsedMs/.test(src('utils', 'scribe', 'implementerTelemetry.ts')))
__resetImplementerTelemetryForTests()

section('(d) ledger state')
check('empty transcript ⇒ "no work has been dispatched"', /no work has been dispatched to the Implementer/.test(buildScribeAwarenessReminder([])))
const withDispatch = buildScribeAwarenessReminder([dispatchMsg])
check('a dispatch ⇒ a [dispatched] row with the title', /\[dispatched\] Task X/.test(withDispatch), withDispatch.split('\n').filter(l => l.includes('Task X')).join(' | '))
check('marks the latest (most recently dispatched), not a false "advanced" recency', /latest \(most recently dispatched\)/.test(withDispatch))

section('(e) wiring (src structural)')
// R3 module-scoped read: the attachments implementation is
// splitting into owned submodules; these invariants are module-scoped, so
// read the barrel + every submodule as one text.
const att = src('utils', 'attachments.ts') + readdirSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'attachments')).filter(f => f.endsWith('.ts')).map(f => src('utils', 'attachments', f)).join('\n')
check("Attachment union has type 'scribe_awareness'", /type:\s*'scribe_awareness'/.test(att))
check('a self-gated producer exists', /function getScribeAwarenessAttachment/.test(att))
check('registered in allThreadAttachments via maybe()', /maybe\('scribe_awareness',/.test(att))
check('registered adjacent to critical_system_reminder (unconditional region, not feature-gated)', /maybe\('critical_system_reminder',[\s\S]{0,160}maybe\('scribe_awareness',/.test(att))
const msgs = src('utils', 'messages', 'attachmentText.ts')
check("normalizeAttachmentForAPI has case 'scribe_awareness'", /case 'scribe_awareness':/.test(msgs))
check('wraps once via wrapMessagesInSystemReminder + isMeta', /case 'scribe_awareness':[\s\S]{0,200}wrapMessagesInSystemReminder[\s\S]{0,120}isMeta:\s*true/.test(msgs))
const nullr = src('components', 'messages', 'nullRenderingAttachments.ts')
check("NULL_RENDERING_TYPES includes 'scribe_awareness' (operator-invisible)", /'scribe_awareness'/.test(nullr))

section('(f) #47 chatroom mode — the reminder flips to peer-chat IN LOCKSTEP with the pack')
process.env.MERCURY_SCRIBE_CHATROOM = '1'
const chatOn = buildScribeAwarenessReminder([])
check('chatroom ON ⇒ peer-chat opening (shared chat the operator OBSERVES)', /shared chat the operator OBSERVES/.test(chatOn) && /Address the Implementer directly by name/.test(chatOn))
check('chatroom ON ⇒ still bus-write≠receipt honest (never post a reply on its behalf)', /Never post a reply on the Implementer/.test(chatOn) && /until a REAL Implementer .* appears/i.test(chatOn))
check('chatroom ON ⇒ dispatch instruction says speak TO the Implementer in-chat', /speak TO the Implementer in-chat by name/.test(chatOn))
check('chatroom OFF (=0) ⇒ single-surface opening (not the peer-chat one)', !/shared chat the operator OBSERVES/.test(busLive) && /the only surface the operator talks to/.test(busLive))
delete process.env.MERCURY_SCRIBE_CHATROOM

// Restore a clean env for the rest of the suite.
delete process.env.MERCURY_SCRIBE
setScribeMode(false)
setStamp(false)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL AWARENESS PROOFS PASS')
else console.log(`❌ ${failures} AWARENESS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
