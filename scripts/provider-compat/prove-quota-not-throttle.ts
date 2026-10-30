import { turn, answer } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
import { mapCompatHttpFailure } from '../../src/services/providers/openaicompat/compatChatClient.ts'
import { compatFaultToTypedError } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
for (const code of ['insufficient_quota', 'billing_hard_limit_reached', 'exceeded_current_quota_error']) {
  const body = { error: { code, message: 'Account requires a top-up' } }
  const result = await turn(() => Response.json(body, { status: 429 }))
  assert.equal(result.requests.length, 1, code)
  assert.equal(result.events.find(e => e.type === 'assistant')?.error, 'billing_error', code)
  const fault = mapCompatHttpFailure(429, body, new Headers({ 'retry-after': '5' }))
  assert.equal(fault.retryable, false)
  assert.equal(compatFaultToTypedError(fault), 'billing_error')
  assert.equal(fault.retryAfterMs, undefined)
}
for (const code of ['rate_limit_exceeded', 'RESOURCE_EXHAUSTED']) {
  const result = await turn(attempt => attempt === 1 ? Response.json({ error: { code, message: 'Quota exceeded for a request window' } }, { status: 429 }) : answer())
  assert.equal(result.requests.length, 2, code)
  assert(result.events.some(e => e.type === 'assistant' && !e.isApiErrorMessage))
}
console.log('P04 billing quota refusals stop once; request-window throttles retry and serve')
