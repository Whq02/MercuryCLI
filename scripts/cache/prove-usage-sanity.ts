import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
const { decodeCompatUsage } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { mapCompatUsageToAnthropic } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { calculateUSDCost } = await import('../../src/utils/modelCost.ts')
const ledger = await import('../../src/cost-tracker.ts')
for (const raw of ['{"prompt_tokens":-10,"completion_tokens":-50}', '{"prompt_tokens":1e999,"completion_tokens":5}', '{"prompt_tokens":10,"completion_tokens":1e999,"cost":-3}']) {
  const decoded = decodeCompatUsage(JSON.parse(raw))
  const usage = mapCompatUsageToAnthropic(decoded)
  assert(Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0)
  assert(Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0)
  const cost = calculateUSDCost('claude-sonnet-4-6', usage)
  assert(Number.isFinite(cost) && cost >= 0)
  assert(decoded?.statedCostUSD === undefined || decoded.statedCostUSD >= 0)
}
const usage = mapCompatUsageToAnthropic({ inputTokens: 10, outputTokens: 5 })
ledger.resetCostState()
ledger.addToTotalSessionCost(0.5, usage, 'claude-sonnet-4-6')
for (const value of [NaN, Infinity, -1]) {
  const bad = { ...usage, input_tokens: Infinity, output_tokens: -5, cache_read_input_tokens: NaN }
  ledger.addToTotalSessionCost(value, bad, 'claude-sonnet-4-6')
  assert(Number.isFinite(calculateUSDCost('claude-sonnet-4-6', bad)))
}
ledger.addToTotalSessionCost(0.25, usage, 'claude-sonnet-4-6')
assert.equal(ledger.getTotalCost(), 0.75)
assert.equal(ledger.getTotalInputTokens(), 20)
assert.equal(ledger.getTotalOutputTokens(), 10)
assert(!/NaN|Infinity/.test(ledger.formatTotalCost()))
console.log('P08 malformed counts and costs cannot poison later ledger entries')
