#!/usr/bin/env bun

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond ? ' — hint: change mapOpenaiUsageToAnthropic or buildProviderUsageReceipt in src/models/roads/openai/call-model/attemptSettle.ts, or getModelCosts in src/models/usage/modelCost.ts (the hosted-search price check)' : ''}`)
  if (!cond) failures++
}

const { mapOpenaiUsageToAnthropic, buildProviderUsageReceipt } = await import(
  '../../src/models/roads/openai/openaiCallModel.ts'
)

console.log('— D01/D02: disjoint canonical mapping —')
const SPECIMEN = { inputTokens: 607_617, outputTokens: 17_840, cachedInputTokens: 283_648 }
{
  const u = mapOpenaiUsageToAnthropic(SPECIMEN)
  check('uncached input = total − cached', u.input_tokens === 607_617 - 283_648, String(u.input_tokens))
  check('cache_read carries the cached subset', u.cache_read_input_tokens === 283_648)
  check('output passes through', u.output_tokens === 17_840)
  const empty = mapOpenaiUsageToAnthropic(undefined)
  check('absent usage folds to zeros', empty.input_tokens === 0 && empty.output_tokens === 0 && empty.cache_read_input_tokens === 0)
}

console.log('— D03/D04: the field specimen recomputes at the pinned rates —')
{
  const rate = (tokens: number, perM: number): number => (tokens * perM) / 1_000_000
  const u = mapOpenaiUsageToAnthropic(SPECIMEN)
  const canonical =
    rate(u.input_tokens, 5) + rate(u.output_tokens, 30) + rate(u.cache_read_input_tokens, 0.5)
  check('canonical disjoint cost = $2.296869', Math.abs(canonical - 2.296869) < 1e-9, canonical.toFixed(6))
  const inclusive =
    rate(SPECIMEN.inputTokens, 5) + rate(SPECIMEN.outputTokens, 30) + rate(SPECIMEN.cachedInputTokens, 0.5)
  check('the double-count artifact = $3.715109 (what the field paid on paper)', Math.abs(inclusive - 3.715109) < 1e-9, inclusive.toFixed(6))
}

console.log('— D03: anomaly clamp (cached > total) —')
{
  const u = mapOpenaiUsageToAnthropic({ inputTokens: 60, outputTokens: 1, cachedInputTokens: 100 })
  check('uncached clamps to 0, never negative', u.input_tokens === 0)
  check('cache_read stays as reported (the receipt marks the anomaly)', u.cache_read_input_tokens === 100)
  const r = buildProviderUsageReceipt({ inputTokens: 60, outputTokens: 1, cachedInputTokens: 100 })
  check('receipt marks cached-exceeds-total', r.anomaly === 'cached-exceeds-total')
}

console.log('— D07 (FN-018 rank 18): the hosted-search count rides the envelope —')
{
  const searched = mapOpenaiUsageToAnthropic(SPECIMEN, 3)
  check('web_search_requests carries the collected calls', searched.server_tool_use.web_search_requests === 3)
  check('the default is zero (no searches, no counter)', mapOpenaiUsageToAnthropic(SPECIMEN).server_tool_use.web_search_requests === 0)
  const { getModelCosts } = await import('../../src/models/usage/modelCost.ts')
  check('a pinned engine carries no per-search price (the count rides, the price waits for a recorded rate)', getModelCosts('gpt-5.6-sol').webSearchRequests === 0)
}

console.log('— D01/D09: the provider receipt keeps inclusive totals + reasoning detail —')
{
  const r = buildProviderUsageReceipt({
    inputTokens: 607_617,
    outputTokens: 17_840,
    cachedInputTokens: 283_648,
    reasoningOutputTokens: 4_121,
  })
  check('raw INCLUSIVE total survives in the receipt only', r.inputTokensTotal === 607_617)
  check('reasoning output tokens survive decode → receipt', r.reasoningOutputTokens === 4_121)
  check('healthy usage carries no anomaly marker', r.anomaly === undefined)
}


if (failures > 0) {
  console.error(`\nprove-usage-canonical: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-usage-canonical: all green')
