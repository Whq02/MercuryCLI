import { qwenPricingRegion } from './qwenAccounts.js'
import { qwenDisplayPin, qwenPriceTierFor } from './qwenPins.js'
import type { ResolvedModelPricing } from '../../../utils/modelCost.js'

type Price = { costInPerMtok: number; costOutPerMtok: number; cachedInPerMtok?: number; cacheWritePerMtok?: number }
type Tier = Price & { aboveInputTokens: number }

const implicit = (input: number, output: number): Price => ({ costInPerMtok: input, costOutPerMtok: output, cachedInPerMtok: input * 0.2, cacheWritePerMtok: input * 1.25 })
const REGIONAL: Readonly<Record<string, readonly Tier[]>> = {
  'qwen3.8-max': [{ aboveInputTokens: 0, costInPerMtok: 1.65, costOutPerMtok: 4.951, cacheWritePerMtok: 1.65 * 1.25 }],
  'qwen3.7-max': [{ aboveInputTokens: 0, ...implicit(1.65, 4.951) }],
  'qwen3.7-plus': [{ aboveInputTokens: 256000, ...implicit(0.826, 3.301) }, { aboveInputTokens: 0, ...implicit(0.276, 1.101) }],
  'qwen3.8-flash': [{ aboveInputTokens: 0, costInPerMtok: 0.113, costOutPerMtok: 0.382 }],
  'qwen3.7-flash': [{ aboveInputTokens: 256000, ...implicit(0.165, 0.660) }, { aboveInputTokens: 32000, ...implicit(0.083, 0.330) }, { aboveInputTokens: 0, ...implicit(0.028, 0.110) }],
  'qwen3.6-flash': [{ aboveInputTokens: 256000, ...implicit(0.660, 3.961) }, { aboveInputTokens: 0, ...implicit(0.165, 0.990) }],
}

const PRICE_ALIASES: Readonly<Record<string, string>> = {
  'qwen3.8-max-0902': 'qwen3.8-max',
  'qwen3.7-max-2026-05-20': 'qwen3.7-max',
  'qwen3.7-max-2026-06-08': 'qwen3.7-max',
  'qwen3.7-plus-2026-05-26': 'qwen3.7-plus',
  'qwen3.7-flash-2026-07-15': 'qwen3.7-flash',
  'qwen3.6-flash-2026-04-16': 'qwen3.6-flash',
}

export function qwenRegionalPrice(model: string, promptTokens?: number, env: NodeJS.ProcessEnv = process.env): Price | undefined {
  const region = qwenPricingRegion(env)
  if (region === undefined || promptTokens !== undefined && promptTokens > 1000000) return undefined
  const raw = model.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  const id = PRICE_ALIASES[raw] ?? raw
  if (region === 'singapore') {
    const pin = qwenDisplayPin(id)
    const price = pin === undefined ? undefined : qwenPriceTierFor(pin, promptTokens)
    return price?.costInPerMtok !== undefined && price.costOutPerMtok !== undefined ? { ...price, costInPerMtok: price.costInPerMtok, costOutPerMtok: price.costOutPerMtok } : undefined
  }
  if (region === 'virginia'
    || region === 'tokyo' && (id === 'qwen3.7-plus' || raw === 'qwen3.7-max-2026-06-08')
    || region !== 'beijing' && id === 'qwen3.8-flash'
    || (region === 'tokyo' || region === 'hongkong') && raw === 'qwen3.6-flash-2026-04-16') return undefined
  return REGIONAL[id]?.find(tier => tier.aboveInputTokens === 0 || promptTokens !== undefined && promptTokens > tier.aboveInputTokens)
}

export function qwenResolvedPricing(model: string, promptTokens?: number): ResolvedModelPricing | undefined {
  const price = qwenRegionalPrice(model, promptTokens)
  if (price === undefined) return undefined
  return {
    costs: {
      inputTokens: price.costInPerMtok,
      outputTokens: price.costOutPerMtok,
      promptCacheReadTokens: price.cachedInPerMtok ?? 0,
      promptCacheWriteTokens: price.cacheWritePerMtok ?? 0,
      webSearchRequests: 0,
    },
    basis: price.cachedInPerMtok === undefined || price.cacheWritePerMtok === undefined ? 'unpriced' : 'recorded',
  }
}
