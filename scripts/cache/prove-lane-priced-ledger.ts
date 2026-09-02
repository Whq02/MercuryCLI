#!/usr/bin/env bun
// ============================================================================
//  scripts/cache/prove-lane-priced-ledger.ts — every lane with a RECORDED
//  price feeds the ledger at that price (FN-018 rank 3: DeepSeek, Kimi,
//  GLM, Gemini and local turns were priced at an Anthropic fallback tier).
//
//  modelCost's pinned-engine lookup consulted the GPT pin table alone.
//  DeepSeek and Kimi carry their official published rates in-repo (the
//  same pin shape) but reached only the /caching display, so a DeepSeek V4
//  Flash turn correct at $0.0509 was recorded at $0.635 — a factor of 12.5,
//  always over — in the /cost lane rows, the exit summary, the persisted
//  cost row and the headless total_cost_usd; a local server's turn, correct
//  at $0, recorded the same $0.635 under the unknown-cost flag.
//
//   §1 the pinned lanes price at their own recorded rates
//   §2 the local lane is a recorded zero, never an unknown cost
//   §3 a lane with no recorded rate lands UNPRICED: zero USD under the
//      unknown-cost flag (never an invented rate, never a silent zero —
//      the usage-neutrality law re-cut the earlier flagged first-party
//      fallback: another vendor's tier is not a price; the per-lane spend
//      views say "unpriced" beside the figure, prove-pricing-by-provider)
//   §4 the first-party table and the GPT pins are untouched
//   §5 the shape
//
//  Run:  ~/.bun/bin/bun run scripts/cache/prove-lane-priced-ledger.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-lane-priced-'))
delete process.env.ANTHROPIC_MODEL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

const { getModelCosts, calculateUSDCost, COST_TIER_5_25 } = await import('../../src/utils/modelCost.ts')
const state = await import('../../src/bootstrap/state.ts')
const { deepseekDisplayPin } = await import('../../src/services/providers/deepseek/deepseekPins.ts')
const { kimiDisplayPin } = await import('../../src/services/providers/moonshot/kimiPins.ts')

type Usage = Parameters<typeof calculateUSDCost>[1]
const usage = (input: number, output: number, cacheRead = 0): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
})
const perM = (tokens: number, rate: number): number => (tokens * rate) / 1e6

console.log('every lane with a recorded price feeds the ledger at that price')

// ── §1 the pinned lanes ─────────────────────────────────────────────────────
section('§1 DeepSeek and Kimi price at their own recorded rates (the base priced them at the Anthropic fallback tier)')
{
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const pin = deepseekDisplayPin(id)
    const tier = getModelCosts(id)
    check(`${id}: the pin records a price (the fixture is meaningful)`, pin?.costInPerMtok !== undefined && pin?.costOutPerMtok !== undefined)
    check(`${id}: input at the pin's rate`, tier.inputTokens === pin?.costInPerMtok, `${tier.inputTokens} vs ${String(pin?.costInPerMtok)}`)
    check(`${id}: output at the pin's rate`, tier.outputTokens === pin?.costOutPerMtok)
    check(`${id}: cache-read at the pin's documented cached rate`, tier.promptCacheReadTokens === pin?.cachedInPerMtok)
    check(`${id}: cache-write at the input rate (nothing extra to populate the prefix cache)`, tier.promptCacheWriteTokens === pin?.costInPerMtok)
  }
  const flash = deepseekDisplayPin('deepseek-v4-flash')!
  const specimen = usage(100_000, 10_000, 20_000)
  const priced = calculateUSDCost('deepseek-v4-flash', specimen)
  const expected = perM(100_000, flash.costInPerMtok!) + perM(10_000, flash.costOutPerMtok!) + perM(20_000, flash.cachedInPerMtok!)
  const fallback = perM(100_000, COST_TIER_5_25.inputTokens) + perM(10_000, COST_TIER_5_25.outputTokens) + perM(20_000, COST_TIER_5_25.promptCacheReadTokens)
  check('a DeepSeek V4 Flash turn prices at the pin arithmetic', near(priced, expected), `${priced} vs ${expected}`)
  check('…an order of magnitude under the fallback tier the base charged', priced < fallback / 8, `${priced} vs fallback ${fallback}`)
  const kimi = kimiDisplayPin('kimi-k3')!
  const kimiTier = getModelCosts('kimi-k3')
  check('kimi-k3: input/output/cache-read at the pin', kimiTier.inputTokens === kimi.costInPerMtok && kimiTier.outputTokens === kimi.costOutPerMtok && kimiTier.promptCacheReadTokens === kimi.cachedInPerMtok, JSON.stringify(kimiTier))
  check('kimi-k3: a turn prices at the pin arithmetic', near(calculateUSDCost('kimi-k3', usage(1_000_000, 100_000)), perM(1_000_000, kimi.costInPerMtok!) + perM(100_000, kimi.costOutPerMtok!)))
  check('pinned lanes never raise the unknown-cost flag', state.hasUnknownModelCost() === false)
}

// ── §2 the local lane ───────────────────────────────────────────────────────
section('§2 the local lane is a recorded zero, never an unknown cost')
{
  const tier = getModelCosts('local/llama3.1:8b')
  check('a local server prices at zero on every axis', tier.inputTokens === 0 && tier.outputTokens === 0 && tier.promptCacheReadTokens === 0 && tier.promptCacheWriteTokens === 0 && tier.webSearchRequests === 0, JSON.stringify(tier))
  check('a local turn costs $0.00 (the base recorded $0.635 with the caveat)', calculateUSDCost('local/llama3.1:8b', usage(100_000, 10_000)) === 0)
  check('…and the unknown-cost caveat is NOT raised for it (a zero is the truth, not a guess)', state.hasUnknownModelCost() === false)
}

// ── §3 the unpriced lane ────────────────────────────────────────────────────
section('§3 a lane with no recorded rate lands unpriced: zero USD under the unknown-cost flag, never another vendor\'s tier')
{
  state.setHasUnknownModelCost(false)
  const tier = getModelCosts('compat/fixture-model')
  check('a custom endpoint (no rate is knowable) resolves to the zero tier — never the first-party 5/25 tier the base charged', tier.inputTokens === 0 && tier.outputTokens === 0 && tier.promptCacheReadTokens === 0 && tier.promptCacheWriteTokens === 0)
  check('…and raises the unknown-cost flag so the caveat prints (the zero is never silent)', state.hasUnknownModelCost() === true)
  check('…and a turn on it lands at $0 with its tokens counted by the caller', calculateUSDCost('compat/fixture-model', usage(100_000, 10_000)) === 0)
  state.setHasUnknownModelCost(false)
  const glm = getModelCosts('glm-5.3')
  check('GLM is no longer the unpriced lane: glm-5.3 prices at its own published pin (docs.z.ai)', glm.inputTokens === 1.4 && glm.outputTokens === 4.4 && state.hasUnknownModelCost() === false, JSON.stringify(glm))
}

// ── §4 untouched lanes ──────────────────────────────────────────────────────
section('§4 the first-party table and the GPT pins are untouched')
{
  const sonnet = getModelCosts('claude-sonnet-5')
  check('claude-sonnet-5 keeps the 3/15 tier', sonnet.inputTokens === 3 && sonnet.outputTokens === 15)
  const { gptDisplayPin } = await import('../../src/services/providers/openai/gptPins.ts')
  const gptId = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'].find(id => gptDisplayPin(id)?.costInPerMtok !== undefined)
  if (gptId !== undefined) {
    const pin = gptDisplayPin(gptId)!
    check(`${gptId} keeps its GPT pin price`, getModelCosts(gptId).inputTokens === pin.costInPerMtok && getModelCosts(gptId).outputTokens === pin.costOutPerMtok)
  } else {
    check('a priced GPT pin exists to compare (fixture)', false, 'no priced gpt pin id found among the guesses')
  }
}

// ── §5 the shape ────────────────────────────────────────────────────────────
section('§5 the shape')
{
  const src = readFileSync(join(ROOT, 'src/utils/modelCost.ts'), 'utf8')
  check('each pinned engine has its OWN owner row: the GPT, DeepSeek and Kimi pins', /openai: model => recorded\(engineTier\(gptDisplayPin\(model\)\)\)/.test(src) && /deepseek: model => recorded\(engineTier\(deepseekDisplayPin\(model\)\)\)/.test(src) && /moonshot: model => recorded\(engineTier\(kimiDisplayPin\(model\)\)\)/.test(src))
  check('the local lane resolves at its recorded zero through its own owner row', /local: \(\) => \(\{ costs: COST_LOCAL_SERVER, basis: 'recorded' \}\)/.test(src))
  const pins = readFileSync(join(ROOT, 'src/services/providers/deepseek/deepseekPins.ts'), 'utf8')
  check('the DeepSeek pin comment no longer claims the ledger never uses these rates', !/the ledger never invents USD from these/.test(pins))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-lane-priced-ledger${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
