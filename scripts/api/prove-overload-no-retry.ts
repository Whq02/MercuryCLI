import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
process.env.MERCURY_BUSY_RETRY_SCALE = '0.001'
const { isRetryableError, withRetry } = await import('../../src/services/api/withRetry.ts')
const message = JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } })
for (const status of [400, 408, 500, 529]) {
  for (const headers of [new Headers({ 'x-should-retry': 'false' }), { 'X-Should-Retry': 'false' }]) {
    const error = Object.assign(new Error(message), { status, headers })
    assert.equal(isRetryableError(error), false, String(status))
    let calls = 0
    try {
      for await (const _ of withRetry(async () => ({} as never), async () => { calls++; throw error }, { model: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, maxRetries: 1 })) {}
      assert.fail('must preserve refusal')
    } catch { assert.equal(calls, 1) }
  }
}
assert.equal(isRetryableError(Object.assign(new Error(message), { status: 529 })), true)
console.log('P12 explicit no-retry prevents the overload busy ladder')
