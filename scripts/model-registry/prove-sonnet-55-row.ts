#!/usr/bin/env bun
import { mkdtempSync as mkScratch } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as pathJoin } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkScratch(pathJoin(osTmp(), 'sonnet-55-row-proof-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = proofHome
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

for (const k of [
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
]) {
  delete process.env[k]
}

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ID = 'claude-sonnet-5-5'
const PREVIOUS = 'claude-sonnet-5'

section("§1 the price row: the vendor's tier for claude-sonnet-5-5 is recorded, never a family estimate")
{
  const { calculateUSDCost, getModelPricingString, resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const pricing = resolveModelPricing(ID)
  check('the cost tier is recorded: $2 in, $10 out, $2.50 5m write, $0.20 cache read', pricing.basis === 'recorded' && pricing.costs.inputTokens === 2 && pricing.costs.outputTokens === 10 && pricing.costs.promptCacheWriteTokens === 2.5 && pricing.costs.promptCacheReadTokens === 0.2, JSON.stringify(pricing))
  check("the price string reads '$2/$10 per Mtok'", getModelPricingString(ID) === '$2/$10 per Mtok', String(getModelPricingString(ID)))
  const oneHour = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })
  const fiveMinute = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  const read = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })
  const spent = calculateUSDCost(ID, { input_tokens: 1_000_000, output_tokens: 1_000_000 })
  check('a million 1h-written tokens cost $4, 5m-written $2.50, read $0.20, a million in and out $12', Math.abs(oneHour - 4) < 1e-9 && Math.abs(fiveMinute - 2.5) < 1e-9 && Math.abs(read - 0.2) < 1e-9 && Math.abs(spent - 12) < 1e-9, `${oneHour}/${fiveMinute}/${read}/${spent}`)
  check('the [1m] twin and a case-changed spelling price at the same recorded tier', resolveModelPricing(`${ID}[1m]`).basis === 'recorded' && resolveModelPricing(`${ID}[1m]`).costs.inputTokens === 2 && resolveModelPricing('Claude-Sonnet-5-5').basis === 'recorded', `${resolveModelPricing(`${ID}[1m]`).basis} / ${resolveModelPricing('Claude-Sonnet-5-5').basis}`)
  check('a dated snapshot of the row prices at the same recorded tier', resolveModelPricing('claude-sonnet-5-5-20260928').basis === 'recorded' && resolveModelPricing('claude-sonnet-5-5-20260928').costs.outputTokens === 10, JSON.stringify(resolveModelPricing('claude-sonnet-5-5-20260928')))
  check('a carrier-shaped spelling never reaches the first-party tier', resolveModelPricing('openrouter/anthropic/claude-sonnet-5-5').basis !== 'recorded' || resolveModelPricing('openrouter/anthropic/claude-sonnet-5-5').costs.inputTokens !== 2, JSON.stringify(resolveModelPricing('openrouter/anthropic/claude-sonnet-5-5')))
  check('Sonnet 5 keeps its own recorded row', resolveModelPricing(PREVIOUS).basis === 'recorded', resolveModelPricing(PREVIOUS).basis)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Sonnet 5.5 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL SONNET 5.5 ROW PROOFS PASS')
