import { turn, answer } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
import { mapCompatHttpFailure } from '../../src/services/providers/openaicompat/compatChatClient.ts'
const body = { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } }
const wait = (headers: Record<string, string>) => mapCompatHttpFailure(429, body, new Headers(headers)).retryAfterMs
assert.equal(wait({ 'retry-after-ms': '1500' }), 1500)
assert.equal(wait({ 'x-ratelimit-reset-requests': '1m30s' }), 90000)
assert.equal(wait({ 'x-ratelimit-reset-tokens': '6.5s' }), 6500)
assert.equal(wait({ 'x-ratelimit-reset-tokens': '1' }), 1000)
assert.equal(wait({ 'retry-after': '2', 'retry-after-ms': '1500', 'x-ratelimit-reset-requests': '1d' }), 2000)
assert.equal(wait({ 'retry-after': '0', 'x-ratelimit-reset-requests': '1d' }), 0)
assert.equal(wait({ 'retry-after-ms': '-1', 'x-ratelimit-reset-requests': 'NaN' }), undefined)
assert.equal(wait({ 'x-ratelimit-reset-requests': '1d', 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-tokens': '1s', 'x-ratelimit-remaining-tokens': '0' }), 1000)
for (const headers of [{ 'retry-after-ms': '750' }, { 'x-ratelimit-reset-tokens': '750ms' }] as Record<string, string>[]) {
  const result = await turn(attempt => attempt === 1 ? Response.json(body, { status: 429, headers }) : answer())
  assert.equal(result.requests.length, 2)
  assert(result.times[1]! - result.times[0]! >= 700)
  assert(result.events.some(e => e.type === 'assistant' && !e.isApiErrorMessage))
}
console.log('P11 compat retries honor explicit waits before exhausted-window reset hints')
assert.equal(mapCompatHttpFailure(500, {}, new Headers({ 'x-ratelimit-reset-requests': '1d' })).retryAfterMs, undefined)
assert.equal(mapCompatHttpFailure(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } }, new Headers({ 'x-ratelimit-reset-requests': '1d' })).retryAfterMs, 1000)
