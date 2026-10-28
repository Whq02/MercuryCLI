#!/usr/bin/env bun
import React from 'react'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

const { createSystemAPIErrorMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')
const { API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errorPrefix.ts')
const { APIConnectionError, APIConnectionTimeoutError, APIError } = await import('../../src/services/api/sdkErrors.ts')
const { NetworkOutageError, ReconnectBudgetSpentError, nextReconnect, openReconnectLadder } = await import('../../src/services/api/reconnectLadder.ts')
const { transportCutWords } = await import('../../src/services/api/transportEvidence.ts')
const { firstByteTimeoutLine, retryNoticeWait, requestWaitLine } = await import('../../src/services/providers/streamIdleBudget.ts')
const { recoveryNoticeFacts } = await import('../../src/services/api/recoveryBudget.ts')
const { isNullRenderingSystemRow, isTransportRetryNotice } = await import('../../src/components/messages/nullRenderingAttachments.ts')
const { retryWaitRow } = await import('../../src/rows/project.ts')
const { SystemTextMessage } = await import('../../src/components/messages/SystemTextMessage.tsx')
const { AssistantTextMessage } = await import('../../src/components/messages/AssistantTextMessage.tsx')
const { renderToString } = await import('../../src/utils/staticRender.tsx')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const paint = async (message: unknown): Promise<string> =>
  (await renderToString(React.createElement(SystemTextMessage, { message: message as never, verbose: false }), 100)).trim()

const fetchFailed = (code: string, syscall: string): Error => {
  const inner = Object.assign(new Error(`${syscall} ${code}`), { code, syscall, errno: -54 })
  return new TypeError('fetch failed', { cause: inner })
}
const reset = createSystemAPIErrorMessage(new APIConnectionError({ cause: fetchFailed('ECONNRESET', 'read') }), 1_000, 1, 10)
const pipe = createSystemAPIErrorMessage(new APIConnectionError({ cause: fetchFailed('EPIPE', 'write') }), 500, 2, 10)
const cut = createSystemAPIErrorMessage(Object.assign(new Error(`${transportCutWords('The provider', { code: 'ECONNRESET', words: 'read ECONNRESET' })}; retrying on a fresh connection`), { cause: fetchFailed('ECONNRESET', 'read') }), 1_000, 1, 10)
const firstByte = createSystemAPIErrorMessage(new APIConnectionTimeoutError({ message: firstByteTimeoutLine({ kind: 'first-byte', cold: false, promptTokens: 54_000, model: 'Opus 5.5', budgetMs: 360_000, sinceMs: 0, attempt: 1 }), requestDeadline: true }), 1_000, 1, 10)
const ladder = openReconnectLadder(0, { code: 'ENOTFOUND', words: 'host not found' }, 10 * 60_000, 1)
const rung = nextReconnect(ladder, { code: 'ENOTFOUND', words: 'host not found' }, 0)
const outage = createSystemAPIErrorMessage(new NetworkOutageError(rung, new APIConnectionError({ cause: fetchFailed('ENOTFOUND', 'getaddrinfo') })), rung.waitMs, rung.reconnect, rung.of)
const fallback = createSystemAPIErrorMessage(new Error('no stream events within 6m of dispatch — the request was accepted and the wait is provider-side; reissuing the stream'), 0, 1, 10, { recoveryTimeoutMs: 300_000 })
const busy = createSystemAPIErrorMessage(new APIError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()), 4_000, 2, 6)
const rateLimited = createSystemAPIErrorMessage(new APIError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, undefined, new Headers({ 'retry-after': '30' })), 30_000, 1, 10)
const overloadedStatusLost = createSystemAPIErrorMessage(new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 2_000, 1, 10)
const serverError = createSystemAPIErrorMessage(new APIError(503, { type: 'error', error: { type: 'api_error', message: 'upstream unavailable' } }, undefined, new Headers()), 2_000, 1, 10)

section('§1 the predicate: a transport retry the road heals by itself is never painted; a provider’s answer keeps its row')
{
  for (const [name, row] of [['a connection reset', reset], ['a broken pipe mid-upload', pipe], ['a mid-response cut', cut], ['a first-byte timeout', firstByte], ['a reconnect rung of the outage ladder', outage], ['a stream reissue', fallback]] as const) {
    check(`${name}: not painted`, isTransportRetryNotice(row as never) && isNullRenderingSystemRow(row as never), JSON.stringify(row.errorDetail))
  }
  for (const [name, row] of [['a 529 overloaded answer', busy], ['a 429 with Retry-After', rateLimited], ['a 503', serverError], ['an overloaded answer whose status was lost', overloadedStatusLost]] as const) {
    check(`${name}: painted as before`, !isTransportRetryNotice(row as never) && !isNullRenderingSystemRow(row as never), JSON.stringify(row.errorDetail))
  }
  const resumed = { ...reset, error: {} as never }
  check('a row read back from the transcript (error:{}) is judged by its errorDetail: still not painted', isTransportRetryNotice(resumed as never))
}

section('§2 the ink render: nothing for a healing transport retry; the existing words for a provider’s answer')
{
  for (const [name, row] of [['connection reset', reset], ['first-byte timeout', firstByte], ['outage rung', outage], ['stream reissue', fallback]] as const) {
    const painted = await paint(row)
    check(`${name}: the painter prints nothing`, painted === '', JSON.stringify(painted).slice(0, 200))
  }
  const painted429 = await paint(rateLimited)
  check('a 429 keeps its row: the red mark, the words, the countdown', painted429.includes('rate limited') && /Retrying in \d+ seconds… \(attempt 1\/10\)/.test(painted429), JSON.stringify(painted429).slice(0, 300))
  const painted529 = await paint(busy)
  check('a 529 keeps its row', painted529.includes('Overloaded') && painted529.includes('(attempt 2/6)'), JSON.stringify(painted529).slice(0, 300))
}

section('§3 the receipts: the retry is still recorded — the row keeps its facts for the transcript, the budget and the SDK stream')
{
  check('the notice row is a transcript row (not meta) with its retry facts', (reset as { isMeta?: boolean }).isMeta !== true && reset.retryAttempt === 1 && reset.maxRetries === 10 && reset.retryInMs === 1_000 && reset.errorDetail?.transport?.code === 'ECONNRESET', JSON.stringify(reset.errorDetail))
  const facts = recoveryNoticeFacts(reset)
  check('the recovery budget still reads it as a fault wait', facts !== null && facts.kind === 'fault' && facts.cause === 'connection lost' && facts.declaredMs === 1_000, JSON.stringify(facts))
  const wait = retryNoticeWait(reset, 0)
  check('the status row still speaks the wait with its existing words', requestWaitLine(wait) === 'retrying — attempt 1 of 10 after a connection error · in 1 s', requestWaitLine(wait))
  const sdk = retryWaitRow({ session_id: 's', turn: 1 } as never, { attempt: reset.retryAttempt, of: reset.maxRetries, reason: 'a connection error', delayMs: reset.retryInMs, httpStatus: null, sinceMs: 1 }) as { type: string; state: string; attempt?: number; reason: string }
  check('the SDK row the run stream carries is unchanged: wait/retry with the attempt and the reason', sdk.type === 'wait' && sdk.state === 'retry' && sdk.attempt === 1 && sdk.reason === 'a connection error', JSON.stringify(sdk))
}

section('§4 a failure that ends the attempt keeps its existing words: the spent reconnect budget')
{
  const spentLadder = openReconnectLadder(0, { code: 'ENOTFOUND', words: 'host not found' }, 10 * 60_000, 1)
  for (let i = 0; i < 8; i++) nextReconnect(spentLadder, { code: 'ENOTFOUND', words: 'host not found' }, 10 * 60_000 * (i / 8))
  const spentStep = nextReconnect(spentLadder, { code: 'ENOTFOUND', words: 'host not found' }, 11 * 60_000)
  check('the ladder is spent', spentStep.spent && spentStep.waitMs === 0)
  const spentNotice = createSystemAPIErrorMessage(new NetworkOutageError(spentStep, new Error('x')), 0, spentStep.reconnect, spentStep.of)
  check('the last rung’s notice is not painted either (the final row carries the words)', isNullRenderingSystemRow(spentNotice as never))
  const spentError = new ReconnectBudgetSpentError(spentLadder, 11 * 60_000, new Error('x'))
  const finalRow = createAssistantAPIErrorMessage({ content: `${API_ERROR_MESSAGE_PREFIX}: ${spentError.message}` })
  const text = (finalRow.message.content[0] as { text: string }).text
  const paintedFinal = (await renderToString(React.createElement(AssistantTextMessage, { param: { type: 'text', text } }), 100)).trim()
  check('the final error row paints the spent line as it stands', paintedFinal.includes('the network was unreachable through') && paintedFinal.includes('reconnect budget is spent') && paintedFinal.includes('the turn was ended'), JSON.stringify(paintedFinal).slice(0, 400))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
