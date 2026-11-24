#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import {
  API_ERROR_MESSAGE_PREFIX,
  STREAM_FAULT_AFTER_PARTIAL_MARKER,
  isContinuableStreamFaultMessage,
  streamFaultAfterPartialText,
} from '../../src/engine/requests/apiErrorRows.js'
import { createAssistantAPIErrorMessage } from '../../src/engine/messages/messages.js'


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

{
  const text = streamFaultAfterPartialText('OpenAI', 'openai-stream-error', 'terminated')
  check('composer carries the API error prefix', text.startsWith(API_ERROR_MESSAGE_PREFIX))
  check('composer carries the marker', text.includes(STREAM_FAULT_AFTER_PARTIAL_MARKER))
  const faultTail = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
  check('classifier accepts the composed tail', isContinuableStreamFaultMessage(faultTail))
  const rateLimit = createAssistantAPIErrorMessage({
    content: `${API_ERROR_MESSAGE_PREFIX}: rate limited`,
    error: 'unknown',
  })
  check('classifier rejects other API errors', !isContinuableStreamFaultMessage(rateLimit))
  const nonError = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
  nonError.isApiErrorMessage = false
  check('classifier requires the API-error flag', !isContinuableStreamFaultMessage(nonError))
}


{
  const { decideStreamFaultRecovery } = await import('../../src/engine/loop/turn-machine.js')
  const first = decideStreamFaultRecovery({ continuableTail: true, recoveryCount: 0 })
  check('first fault continues (attempt 1)', first.kind === 'continue' && first.attempt === 1)
  const second = decideStreamFaultRecovery({ continuableTail: true, recoveryCount: 1 })
  check('second fault surfaces (bound = 1 per run)', second.kind === 'surface')
  const other = decideStreamFaultRecovery({ continuableTail: false, recoveryCount: 0 })
  check('non-continuable tails never continue', other.kind === 'surface')
}

{
  const { streamFaultRecoveryContent, streamFaultRecoveryTailLine, STREAM_FAULT_RECOVERY_NUDGE, isStreamFaultRecoveryNudgeText } = await import('../../src/engine/requests/apiErrorRows.js')
  const t = await import('../core-runtime/turnScenarios.ts')
  const { NO_TOOL_RULES, noToolReply, readReply } = await import('../../src/engine/loop/turn/noToolReply.ts')
  type Row = Record<string, unknown>
  const PARTIAL = 'first the schema swap, then the '
  const cutReply = () => ({ script: [t.fixtures.yields(t.fixtures.says(PARTIAL, 'stop_sequence'), t.fixtures.faulted())] })
  const RULE = 'the stream_fault_recovery rule (src/engine/loop/turn/noToolReply.ts)'
  const planted = await t.plantReply(cutReply())
  const apiError = NO_TOOL_RULES.find(rule => rule.name === 'api_error')
  const alone = apiError === undefined ? 'no api_error rule' : t.reasonOf((await t.drain(apiError.decide(planted.run as never, planted.iter as never, readReply(planted.iter as never)))).decision)
  const continued = await t.drain(noToolReply(planted.run as never, planted.iter as never))
  planted.close()
  const next = ((continued.decision as { next?: Row }).next ?? {}) as Row
  const sent = (next.messages ?? []) as Row[]
  const before = planted.iter.messagesForRequest as Row[]
  const reply = planted.iter.assistantMessages as Row[]
  const nudge = sent.at(-1)
  check(
    'a reply cut by a continuable stream fault is continued, though the API-error rule alone would end the run on it (the continuation is decided first)',
    alone === 'end completed' && t.reasonOf(continued.decision) === 'hand_over stream_fault_recovery',
    `${RULE} must stand before api_error in NO_TOOL_RULES and hand the cut reply over; api_error alone said ${alone}, the rules in order said ${t.reasonOf(continued.decision)}`,
  )
  check(
    'the nudge is meta (never rendered as operator input)',
    nudge?.type === 'user' && nudge.isMeta === true && JSON.stringify((nudge.message as Row).content) === JSON.stringify(streamFaultRecoveryContent(PARTIAL)),
    `${RULE} must end the next request with createUserMessage({ content: streamFaultRecoveryContent(the settled reply's text), isMeta: true }); the last row is ${JSON.stringify({ type: nudge?.type, isMeta: nudge?.isMeta, content: (nudge?.message as Row | undefined)?.content })}`,
  )
  check(
    'the continuation carries the settled reply and never the fault row (the partial is the assistant\'s own last message before the marker)',
    reply.length === 2 && reply[1]?.isApiErrorMessage === true && sent.length === before.length + 2 && before.every((row, index) => sent[index] === row) && sent.at(-2) === reply[0] && !sent.some(row => row.isApiErrorMessage === true),
    `${RULE} must hand over the request's rows, then the reply's rows that are no API error, then the nudge; the reply held ${reply.map(row => (row.isApiErrorMessage === true ? 'the fault row' : 'the partial')).join(' + ')} and the next request holds ${sent.map(row => `${String(row.type)}${row.isApiErrorMessage === true ? ' (the fault row)' : row === reply[0] ? ' (the partial)' : ''}`).join(', ')}`,
  )
  check('a cut before any text ⇒ the plain nudge, as a string, as today', streamFaultRecoveryContent('') === STREAM_FAULT_RECOVERY_NUDGE && streamFaultRecoveryContent('   ') === STREAM_FAULT_RECOVERY_NUDGE && streamFaultRecoveryTailLine('') === null)
  const composed = streamFaultRecoveryContent('first the schema swap, then the ')
  check('a cut after settled text ⇒ two text blocks: the identity nudge (the lookups key on it) and the tail line', Array.isArray(composed) && composed.length === 2 && composed[0]?.type === 'text' && isStreamFaultRecoveryNudgeText((composed[0] as { text: string }).text) && composed[1]?.type === 'text' && (composed[1] as { text: string }).text.includes('“first the schema swap, then the”'), JSON.stringify(composed))
  const long = 'x'.repeat(500) + ' the very last words'
  const tailLine = streamFaultRecoveryTailLine(long) ?? ''
  check('a long reply names its last 160 characters, marked as a tail', tailLine.includes('…') && tailLine.includes(' the very last words”') && !tailLine.includes('x'.repeat(200)), tailLine.slice(0, 80))
  const again = await t.plantReply(cutReply(), { state: { streamFaultRecoveryCount: next.streamFaultRecoveryCount } })
  const surfaced = await t.drain(noToolReply(again.run as never, again.iter as never))
  again.close()
  check(
    'the bound increments into the next state: one continuation is counted there, and a reply cut again under that count is not continued',
    next.streamFaultRecoveryCount === 1 && JSON.stringify(next.transition) === JSON.stringify({ reason: 'stream_fault_recovery', attempt: 1 }) && t.reasonOf(surfaced.decision) === 'end completed' && t.noticesOf(surfaced.events).some(line => line.includes('stopped after 1 continuation; the reply so far stands')),
    `${RULE} must hand over streamFaultRecoveryCount + 1, and with the count at its limit say the reply stands and decide nothing; the next state counts ${JSON.stringify(next.streamFaultRecoveryCount)} with transition ${JSON.stringify(next.transition)}, and the second cut ended ${t.reasonOf(surfaced.decision)} saying ${JSON.stringify(t.noticesOf(surfaced.events))}`,
  )
}

if (failures > 0) {
  console.error('prove-stream-fault-recovery: RED (' + failures + ')')
  process.exit(1)
}
console.log('prove-stream-fault-recovery: green')
