#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const tabs = (await import('../../src/components/mercury-ui/scribeChatTabs.js')) as typeof import('../../src/components/mercury-ui/scribeChatTabs.js')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

console.log('============================================================')
console.log(' Scribe attention loop (#33) — proof')
console.log('============================================================')

const wrap = (from: string, e: unknown) => ({ type: 'user', message: { role: 'user', content: `<teammate-message teammate_id="${from}" color="#3FBFA0">\n${bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0])}\n</teammate-message>` } })
const opMsg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }

section('(i) computeScribeAttention (pure)')
const esc = wrap('implementer', bus.buildEscalate('implementer', 'two schemas, which?', { needsOperator: true }))
check('escalate (needsOperator) ⇒ kind escalate + needsOperator + detail', (() => { const a = tabs.computeScribeAttention([opMsg, esc]); return a.kind === 'escalate' && a.needsOperator === true && /two schemas/.test(a.detail ?? '') })())
check('progress(done) ⇒ kind done', tabs.computeScribeAttention([wrap('implementer', bus.buildProgress('implementer', 'done', { detail: 'merged' }))]).kind === 'done')
check('progress(blocked) ⇒ kind blocked', tabs.computeScribeAttention([wrap('implementer', bus.buildProgress('implementer', 'blocked', { detail: 'perm gate' }))]).kind === 'blocked')
check('progress(working) ⇒ NOT attention (kind none)', tabs.computeScribeAttention([wrap('implementer', bus.buildProgress('implementer', 'working'))]).kind === 'none')
check('empty / no envelope ⇒ none', tabs.computeScribeAttention([opMsg]).kind === 'none' && tabs.computeScribeAttention([]).kind === 'none')
check('latest wins: done after escalate ⇒ done', tabs.computeScribeAttention([esc, wrap('implementer', bus.buildProgress('implementer', 'done'))]).kind === 'done')
const old = [esc, opMsg, opMsg, opMsg, opMsg, opMsg, opMsg, opMsg, opMsg]
check('recency-bounded: escalate older than k ⇒ none (self-quiets, no perpetual nag)', tabs.computeScribeAttention(old, 4).kind === 'none')

section('(ii) awareness reminder surfaces the line gate-on; "" off-Scribe (byte-identical)')
const aware = (await import('../../src/utils/scribe/scribeAwareness.js')) as typeof import('../../src/utils/scribe/scribeAwareness.js')
const sm = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')
sm.setScribeMode(true)
process.env.MERCURY_SCRIBE_CHATROOM = '0'
const onText = aware.buildScribeAwarenessReminder([opMsg, esc])
check('Scribe + recent escalate ⇒ ESCALATED salience line present', /just ESCALATED/.test(onText) && /operator-level/.test(onText))
const doneText = aware.buildScribeAwarenessReminder([wrap('implementer', bus.buildProgress('implementer', 'done', { detail: 'shipped' }))])
check('Scribe + recent done ⇒ DONE confirm/relay line present (default ⇒ in your own prose)', /reports DONE/.test(doneText) && /in your own prose/.test(doneText) && !/via SendUserMessage/.test(doneText))
check('Scribe + no signal ⇒ no attention line', !/just ESCALATED|reports DONE|reports BLOCKED/.test(aware.buildScribeAwarenessReminder([opMsg])))

section('(iii) C1 — done clause is surface-aware (chatroom omits relay; default keeps it)')
const doneEnv = wrap('implementer', bus.buildProgress('implementer', 'done', { detail: 'shipped' }))
delete process.env.MERCURY_SCRIBE_CHATROOM
const doneChat = aware.buildScribeAwarenessReminder([doneEnv])
check('chatroom done ⇒ DONE line still present', /reports DONE/.test(doneChat))
check('chatroom done ⇒ OMITS "via SendUserMessage" relay instruction', !/via SendUserMessage/.test(doneChat))
check('chatroom done ⇒ does NOT instruct relaying the result to the operator', !/relay the result to the operator/.test(doneChat))
check('chatroom done ⇒ instructs acknowledging it INTERNALLY (no double-message)', /acknowledge it internally/.test(doneChat) && /double-message/.test(doneChat))
process.env.MERCURY_SCRIBE_CHATROOM = '0'
const doneDefault = aware.buildScribeAwarenessReminder([doneEnv])
check('default done ⇒ KEEPS "relay the result to the operator in your own prose"', /relay the result to the operator in your own prose/.test(doneDefault))
check('default done ⇒ still never names "via SendUserMessage" (Scribe lacks that tool)', !/via SendUserMessage/.test(doneDefault))
delete process.env.MERCURY_SCRIBE_CHATROOM

sm.setScribeMode(false)
check('off-Scribe (mode off) ⇒ reminder is "" (byte-identical, no attachment)', aware.buildScribeAwarenessReminder([opMsg, esc]) === '')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ATTENTION PROOFS PASS')
else console.log(`❌ ${failures} ATTENTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
