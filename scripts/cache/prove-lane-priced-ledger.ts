#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-lane-priced-'))
delete process.env.MERCURY_MODEL
for (const key of ['MERCURY_HOME', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[key]
const ollamaModels = [{ name: 'llama3.1:8b' }, { name: 'cloud', remote_model: 'upstream', remote_host: 'https://ollama.com' }]
const ollama = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req: Request) {
  const path = new URL(req.url).pathname
  if (path === '/api/tags') return Response.json({ models: ollamaModels })
  if (path === '/api/version') return Response.json({ version: 'fixture' })
  if (path === '/api/ps') return Response.json({ models: ollamaModels.map(row => ({ name: row.name, context_length: 131072 })) })
  if (path === '/api/show') return Response.json({ capabilities: ['completion', 'tools'] })
  return new Response('not found', { status: 404 })
} })
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${ollama.port}`

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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getModelCosts, calculateUSDCost, resolveModelPricing, COST_TIER_5_25 } = await import('../../src/utils/modelCost.ts')
const state = await import('../../src/bootstrap/state.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
await refreshLocalDiscovery({ force: true })
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

section('§1 DeepSeek and Kimi price at their own recorded rates (the base priced them at the Anthropic fallback tier)')
{
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    const pin = deepseekDisplayPin(id)
    const tier = getModelCosts(id)
    check(`${id}: the pin records a price (the fixture is meaningful)`, pin?.costInPerMtok !== undefined && pin?.costOutPerMtok !== undefined)
    check(`${id}: input at the pin's rate`, tier.inputTokens === pin?.costInPerMtok, `${tier.inputTokens} vs ${String(pin?.costInPerMtok)}`)
    check(`${id}: output at the pin's rate`, tier.outputTokens === pin?.costOutPerMtok)
    check(`${id}: cache-read at the pin's documented cached rate`, tier.promptCacheReadTokens === pin?.cachedInPerMtok)
    check(`${id}: cache-write at the input rate (nothing extra to populate the prefix cache)`, tier.promptCacheWriteTokens === pin?.costInPerMtok)
  }
  const flash = deepseekDisplayPin('deepseek-flash')!
  const specimen = usage(100_000, 10_000, 20_000)
  const priced = calculateUSDCost('deepseek-flash', specimen)
  const expected = perM(100_000, flash.costInPerMtok!) + perM(10_000, flash.costOutPerMtok!) + perM(20_000, flash.cachedInPerMtok!)
  const fallback = perM(100_000, COST_TIER_5_25.inputTokens) + perM(10_000, COST_TIER_5_25.outputTokens) + perM(20_000, COST_TIER_5_25.promptCacheReadTokens)
  check('a DeepSeek V4.1 Flash turn prices at the pin arithmetic', near(priced, expected), `${priced} vs ${expected}`)
  check('the retired deepseek-v4-flash id prices at the same pin (the alias folds before the lookup)', near(calculateUSDCost('deepseek-v4-flash', specimen), expected) && getModelCosts('deepseek-v4-flash').inputTokens === flash.costInPerMtok)
  check('…an order of magnitude under the fallback tier the base charged', priced < fallback / 8, `${priced} vs fallback ${fallback}`)
  const kimi = kimiDisplayPin('kimi-k3')!
  const kimiTier = getModelCosts('kimi-k3')
  check('kimi-k3: input/output/cache-read at the pin', kimiTier.inputTokens === kimi.costInPerMtok && kimiTier.outputTokens === kimi.costOutPerMtok && kimiTier.promptCacheReadTokens === kimi.cachedInPerMtok, JSON.stringify(kimiTier))
  check('kimi-k3: a turn prices at the pin arithmetic', near(calculateUSDCost('kimi-k3', usage(1_000_000, 100_000)), perM(1_000_000, kimi.costInPerMtok!) + perM(100_000, kimi.costOutPerMtok!)))
  check('pinned lanes never raise the unknown-cost flag', state.hasUnknownModelCost() === false)
}

section('§2 a discovered local model is a recorded zero, never an unknown cost; a remote model served through the local server is unpriced')
{
  check('the fixture discovered llama3.1:8b as a model running on this machine', localRecordFor('local/llama3.1:8b')?.executionOrigin?.kind === 'local', JSON.stringify(localRecordFor('local/llama3.1:8b')))
  const tier = getModelCosts('local/llama3.1:8b')
  check('a local server prices at zero on every axis', tier.inputTokens === 0 && tier.outputTokens === 0 && tier.promptCacheReadTokens === 0 && tier.promptCacheWriteTokens === 0 && tier.webSearchRequests === 0, JSON.stringify(tier))
  check('the zero is recorded, not unpriced', resolveModelPricing('local/llama3.1:8b').basis === 'recorded', resolveModelPricing('local/llama3.1:8b').basis)
  check('a local turn costs $0.00 (the base recorded $0.635 with the caveat)', calculateUSDCost('local/llama3.1:8b', usage(100_000, 10_000)) === 0)
  check('…and the unknown-cost caveat is NOT raised for it (a zero is the truth, not a guess)', state.hasUnknownModelCost() === false)
  check('the fixture discovered cloud as a remote model behind the local server', localRecordFor('local/cloud')?.executionOrigin?.kind === 'remote', JSON.stringify(localRecordFor('local/cloud')))
  const remote = getModelCosts('local/cloud')
  check('a remote model is unpriced: the zero tier under the unknown-cost flag, never the local zero as a recorded price', remote.inputTokens === 0 && remote.outputTokens === 0 && resolveModelPricing('local/cloud').basis === 'unpriced' && state.hasUnknownModelCost() === true, `${resolveModelPricing('local/cloud').basis} flag=${state.hasUnknownModelCost()}`)
  state.setHasUnknownModelCost(false)
  const unlisted = getModelCosts('local/not-served')
  check('a local id no server listed is unpriced too (nothing is known about it): the zero tier under the flag', unlisted.inputTokens === 0 && resolveModelPricing('local/not-served').basis === 'unpriced' && state.hasUnknownModelCost() === true)
  state.setHasUnknownModelCost(false)
}

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

section('§4 the first-party table and the GPT pins are untouched')
{
  const sonnet = getModelCosts('claude-sonnet-5')
  check('claude-sonnet-5 keeps the 2/10 tier', sonnet.inputTokens === 2 && sonnet.outputTokens === 10)
  const { gptDisplayPin } = await import('../../src/services/providers/openai/gptPins.ts')
  const gptId = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'].find(id => gptDisplayPin(id)?.costInPerMtok !== undefined)
  if (gptId !== undefined) {
    const pin = gptDisplayPin(gptId)!
    check(`${gptId} keeps its GPT pin price`, getModelCosts(gptId).inputTokens === pin.costInPerMtok && getModelCosts(gptId).outputTokens === pin.costOutPerMtok)
  } else {
    check('a priced GPT pin exists to compare (fixture)', false, 'no priced gpt pin id found among the guesses')
  }
}

section('§5 the shape')
{
  const src = readFileSync(join(ROOT, 'src/utils/modelCost.ts'), 'utf8')
  check('each pinned engine has its OWN owner row: the GPT, DeepSeek and Kimi pins', /openai: \(model, promptTokens\) => \{[\s\S]*?recorded\(engineTier\(gptPriceTierFor\(pin, promptTokens\)\)\)/.test(src) && /const pin = gptDisplayPin\(model\)/.test(src) && /deepseek: model => recorded\(engineTier\(deepseekDisplayPin\(model\)\)\)/.test(src) && /moonshot: model => recorded\(engineTier\(kimiDisplayPin\(model\)\)\)/.test(src))
  check('the local lane resolves at its recorded zero through its own owner row, by the discovered record: a remote origin or no record is unpriced', /local: model => \{[\s\S]*?const record = localRecordFor\(model\)[\s\S]*?record === undefined \|\| record\.executionOrigin\?\.kind === 'remote' \? undefined : \{ costs: COST_LOCAL_SERVER, basis: 'recorded' \}/.test(src))
  const pins = readFileSync(join(ROOT, 'src/services/providers/deepseek/deepseekPins.ts'), 'utf8')
  check('the DeepSeek pin comment no longer claims the ledger never uses these rates', !/the ledger never invents USD from these/.test(pins))
}

ollama.stop(true)
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-lane-priced-ledger${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
