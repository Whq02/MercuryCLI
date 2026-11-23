import assert from 'node:assert/strict'
import { mapOpenaiHttpFailure } from '../../src/models/roads/openai/openaiWire.js'
import { providerWaitWords } from '../../src/engine/requests/recoveryBudget.js'

const dash = ` ${String.fromCharCode(0x2014)} `
const window = mapOpenaiHttpFailure(429, { error: { code: 'usage_limit_reached', message: 'limit', resets_in_seconds: 203001 } })
const rate = mapOpenaiHttpFailure(429, { error: { message: 'slow down' } }, new Headers({ 'retry-after': '203001' }))
assert.equal(window.message, ['the usage window is reached', 'resets in 2 d 8 h', 'limit'].join(dash), `usage_limit_reached message reads "${window.message}"; fix mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts`)
assert.equal(rate.message, ['rate limited', 'the provider asks for 2 d 8 h', 'slow down'].join(dash), `retry-after rate limit message reads "${rate.message}"; fix mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts`)
assert.equal(window.retryAfterMs, 203001000, `usage_limit_reached retryAfterMs is ${window.retryAfterMs}; fix mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts to turn resets_in_seconds into milliseconds`)
assert.equal(rate.retryAfterMs, 203001000, `retry-after retryAfterMs is ${rate.retryAfterMs}; fix mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts to turn the retry-after header into milliseconds`)
for (const [ms, words] of [[59_000, '59 s'], [60_000, '1 min'], [3_600_000, '1 h 0 min'], [203001000, '2 d 8 h'], [78 * 3600000, '3 d 6 h'], [(24 * 3600 - 31) * 1000, '23 h 59 min'], [(24 * 3600 - 30) * 1000, '1 d 0 h']] as const) assert.equal(providerWaitWords(ms), words, `providerWaitWords(${ms}) reads "${providerWaitWords(ms)}", expected "${words}"; fix providerWaitWords in src/engine/requests/recoveryBudget.ts`)
console.log('PASS OpenAI window and rate wait words, unchanged numeric waits and formatter boundaries')
