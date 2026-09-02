#!/usr/bin/env bun
// ============================================================================
// prove-usage-canonical — (+ D05/06 pins): the GPT
// lane's usage normalizes to the DISJOINT canonical envelope ONCE, at the
// adapter boundary, with the provider's inclusive totals surviving only in
// the attached receipt.
//
// OpenAI reports INCLUSIVE input (cached_tokens ⊆ input_tokens); the
// canonical (Anthropic-spelled) envelope is DISJOINT (uncached input beside
// cache_read). The pre-verbatim mapping double-counted the cached
// prefix in every consumer — the field specimen priced $3.715109 where the
// correct disjoint arithmetic is $2.296869 (pinned
// here at the fixture rates).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { mapOpenaiUsageToAnthropic, buildProviderUsageReceipt } = await import(
  '../../src/services/providers/openai/openaiCallModel.ts'
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
  // Fixture rates from the supplement's own arithmetic: $5/M input · $30/M
  // output · $0.5/M cached-read.
  const rate = (tokens: number, perM: number): number => (tokens * perM) / 1_000_000
  const u = mapOpenaiUsageToAnthropic(SPECIMEN)
  const canonical =
    rate(u.input_tokens, 5) + rate(u.output_tokens, 30) + rate(u.cache_read_input_tokens, 0.5)
  check('canonical disjoint cost = $2.296869', Math.abs(canonical - 2.296869) < 1e-9, canonical.toFixed(6))
  // The historical (inclusive-mapped) arithmetic — the defect being priced,
  // computed directly so the wrong number stays a visible artifact, never a
  // reachable mapping.
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
  const { getModelCosts } = await import('../../src/utils/modelCost.ts')
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

console.log('— openaiWire decode (D09 leg) —')
{
  const wire = readFileSync(
    join(import.meta.dir, '..', '..', 'src/services/providers/openai/openaiWire.ts'),
    'utf8',
  )
  check('parseUsage decodes cached_tokens from input_tokens_details', wire.includes('input_tokens_details') && wire.includes('cached_tokens'))
  check('parseUsage decodes reasoning_tokens from output_tokens_details', wire.includes('output_tokens_details') && wire.includes('reasoning_tokens'))
}

console.log('— D05/D06 pins: one terminal settlement, receipt-only provider semantics —')
{
  const lane = readFileSync(
    join(import.meta.dir, '..', '..', 'src/services/providers/openai/openaiCallModel.ts'),
    'utf8',
  )
  check(
    'exactly ONE terminal usage assignment (the settled last message)',
    (lane.match(/\.message\.usage = finalUsage/g) || []).length === 1,
  )
  check(
    'the partial message starts with zeroed usage (intermediate parts never carry terminal usage)',
    lane.includes('usage: { ...EMPTY_USAGE }'),
  )
  check(
    'the provider receipt rides apexProviderTurn (receipts only)',
    lane.includes('providerUsage: buildProviderUsageReceipt(usageSeen)'),
  )
  check(
    'session cost is fed from the CANONICAL envelope',
    /addToTotalSessionCost\(\s*calculateUSDCost\(modelId, finalUsage/.test(lane),
  )
}

if (failures > 0) {
  console.error(`\nprove-usage-canonical: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-usage-canonical: all green')
