#!/usr/bin/env bun
import { APIError } from '../../src/services/api/sdkErrors.js'

process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-env-key-not-real'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { providerWaitWords, statedResetWordsOf } = await import('../../src/services/api/recoveryBudget.ts')
const { getAssistantMessageFromError } = await import('../../src/services/api/errors.ts')
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')

const textOf = (row: { message: { content: unknown } }): string =>
  (row.message.content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')

section('§1 one wait formatter, four bands: seconds under a minute, minutes under an hour, hours and minutes under a day, days and hours past it')
const bands: Array<[number, string]> = [
  [0, '0 s'],
  [40_000, '40 s'],
  [59_000, '59 s'],
  [60_000, '1 min'],
  [90_000, '2 min'],
  [12 * 60_000, '12 min'],
  [59 * 60_000 + 20_000, '59 min'],
  [60 * 60_000, '1 h 0 min'],
  [3_600_000 + 6 * 60_000, '1 h 6 min'],
  [23 * 3_600_000 + 59 * 60_000, '23 h 59 min'],
  [24 * 3_600_000, '1 d 0 h'],
  [281_900_000, '3 d 6 h'],
  [477_204_000, '5 d 12 h'],
  [7 * 24 * 3_600_000, '7 d 0 h'],
]
for (const [ms, words] of bands) {
  check(`${ms} ms → ${JSON.stringify(words)}`, providerWaitWords(ms) === words, JSON.stringify(providerWaitWords(ms)))
}

section('§2 the reset a provider states in its own sentence is read in its own spelling')
const stated: Array<[string, string | undefined]> = [
  ['Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 20:34:34', 'at 2026-10-27 20:34:34'],
  ['Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 78h18m19s.', 'in 78h18m19s'],
  ['The window resets in 2 hours', 'in 2 hours'],
  ['Rate limit exceeded. Please try again later.', undefined],
]
for (const [message, words] of stated) {
  check(`${JSON.stringify(message.slice(0, 48))} → ${JSON.stringify(words)}`, statedResetWordsOf(message) === words, JSON.stringify(statedResetWordsOf(message)))
}

section('§3 the Anthropic road names the wait as a time, never raw seconds (the session\'s 477,204 s row)')
{
  const message = "This request would exceed your account's rate limit. Please try again later."
  const body = { type: 'error', error: { type: 'rate_limit_error', message } }
  const row = getAssistantMessageFromError(new APIError(429, body, `429 ${JSON.stringify(body)}`, new Headers({ 'retry-after': '477204' })), 'claude-opus-5')
  check('the row reads the wait in days and hours', textOf(row as never) === `API Error: Anthropic is rate limited (5 d 12 h wait): ${message}`, textOf(row as never))
  check('the row keeps its class and its wait fact', (row as { error?: string }).error === 'rate_limit' && typeof (row as { providerWaitEndsAtMs?: number }).providerWaitEndsAtMs === 'number')
  const short = getAssistantMessageFromError(new APIError(429, body, `429 ${JSON.stringify(body)}`, new Headers({ 'retry-after': '40' })), 'claude-opus-5')
  check('a short wait keeps the seconds spelling', textOf(short as never) === `API Error: Anthropic is rate limited (40 s wait): ${message}`, textOf(short as never))
}

section('§4 the compat road\'s inner detail names the wait the same way (the session\'s Gemini 281,900 s row)')
{
  const message = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 78h18m19s.'
  const fault = mapCompatHttpFailure(429, { error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' } }, new Headers({ 'retry-after': '281900' }))
  check('the fault message reads the wait in days and hours', fault.message === `rate limited (provider asks for 3 d 6 h): ${message}`, fault.message)
  check('the fault keeps the wait in ms for the ladder', fault.retryAfterMs === 281_900_000, String(fault.retryAfterMs))
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-provider-wait-words: ALL LAWS HOLD' : `prove-provider-wait-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
