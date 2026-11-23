import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
const { decodeCompatUsage } = await import('../../src/models/roads/openaicompat/compatChatClient.ts')
const { mapCompatUsageToAnthropic } = await import('../../src/models/roads/openaicompat/compatChatCallModel.ts')
const { calculateUSDCost } = await import('../../src/models/usage/modelCost.ts')
const ledger = await import('../../src/models/usage/sessionCost.ts')
for (const raw of ['{"prompt_tokens":-10,"completion_tokens":-50}', '{"prompt_tokens":1e999,"completion_tokens":5}', '{"prompt_tokens":10,"completion_tokens":1e999,"cost":-3}']) {
  const decoded = decodeCompatUsage(JSON.parse(raw))
  const usage = mapCompatUsageToAnthropic(decoded)
  assert(Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0, `decodeCompatUsage/mapCompatUsageToAnthropic produced invalid input_tokens=${usage.input_tokens} for ${raw}; check compatChatCallModel.ts`)
  assert(Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0, `decodeCompatUsage/mapCompatUsageToAnthropic produced invalid output_tokens=${usage.output_tokens} for ${raw}; check compatChatCallModel.ts`)
  const cost = calculateUSDCost('claude-sonnet-4-6', usage)
  assert(Number.isFinite(cost) && cost >= 0, `calculateUSDCost returned invalid cost=${cost} for ${raw}; check modelCost.ts`)
  assert(decoded?.statedCostUSD === undefined || decoded.statedCostUSD >= 0, `decodeCompatUsage kept negative statedCostUSD=${decoded?.statedCostUSD} for ${raw}; check compatChatClient.ts`)
}
const usage = mapCompatUsageToAnthropic({ inputTokens: 10, outputTokens: 5 })
ledger.resetCostState()
ledger.addToTotalSessionCost(0.5, usage, 'claude-sonnet-4-6')
for (const value of [NaN, Infinity, -1]) {
  const bad = { ...usage, input_tokens: Infinity, output_tokens: -5, cache_read_input_tokens: NaN }
  ledger.addToTotalSessionCost(value, bad, 'claude-sonnet-4-6')
  const badCost = calculateUSDCost('claude-sonnet-4-6', bad)
  assert(Number.isFinite(badCost), `calculateUSDCost returned non-finite cost=${badCost} for poisoned usage (value=${value}); check modelCost.ts`)
}
ledger.addToTotalSessionCost(0.25, usage, 'claude-sonnet-4-6')
assert.equal(ledger.getTotalCost(), 0.75)
assert.equal(ledger.getTotalInputTokens(), 20)
assert.equal(ledger.getTotalOutputTokens(), 10)
const formattedCost = ledger.formatTotalCost()
assert(!/NaN|Infinity/.test(formattedCost), `formatTotalCost leaked non-finite text=${formattedCost.slice(0, 80)}; check cost-tracker.ts`)
console.log('P08 malformed counts and costs cannot poison later ledger entries')
