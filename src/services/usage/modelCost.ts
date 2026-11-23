import { setHasUnknownModelCost } from '../../bootstrap/state.js'
import { usageCount } from '../../utils/api/emptyUsage.js'
import { operatorModelFacts } from '../model/modelOverrides.js'
import { deepseekDisplayPin, deepseekRatePeriod } from '../../utils/model/pins/deepseekPins.js'
import { xaiModelFacts } from '../providers/xai/xaiCatalogue.js'
import { metaDisplayPin } from '../../utils/model/pins/metaPins.js'
import { mistralDisplayPin } from '../../utils/model/pins/mistralPins.js'
import { geminiPricePin, geminiPriceTierFor } from '../../utils/model/pins/geminiPins.js'
import { huggingfaceDisplayPin } from '../../utils/model/pins/huggingfacePins.js'
import type { CallModelRoute } from '../providers/idSpaces.js'
import { kimiDisplayPin } from '../../utils/model/pins/kimiPins.js'
import { gptDisplayPin, gptPriceTierFor } from '../../utils/model/pins/gptPins.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { glmPricePin } from '../../utils/model/pins/glmPins.js'
import { zenDisplayPin } from '../../utils/model/pins/zenPins.js'
import { minimaxDisplayPin } from '../../utils/model/pins/minimaxPins.js'
import { togetherDisplayPin } from '../../utils/model/pins/togetherPins.js'
import { cohereDisplayPin } from '../../utils/model/pins/coherePins.js'
import { groqDisplayPin } from '../../utils/model/pins/groqPins.js'
import { cerebrasDisplayPin } from '../../utils/model/pins/cerebrasPins.js'
import { fireworksDisplayPin } from '../../utils/model/pins/fireworksPins.js'
import { qwenRegionalPrice, qwenResolvedPricing } from '../providers/qwen/qwenPricing.js'
import { getCanonicalName, getDefaultEngineModelSetting, type ModelShortName } from '../model/model.js'
import { ALL_MODEL_CONFIGS, familyHeadOf } from '../../utils/model/configs.js'
import { passedOver } from '../../utils/passedOver.js'


export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

export type PricingBasis = 'recorded' | 'floor' | 'family-estimate' | 'unpriced'

export interface ResolvedModelPricing {
  costs: ModelCosts
  basis: PricingBasis
}

const WEB_SEARCH_PER_REQUEST = 0.01

function tierFromInputOutput(input: number, output: number): ModelCosts {
  return {
    inputTokens: input,
    outputTokens: output,
    promptCacheWriteTokens: input * 1.25,
    promptCacheReadTokens: input * 0.1,
    webSearchRequests: WEB_SEARCH_PER_REQUEST,
  }
}

export const COST_TIER_2_10: ModelCosts = tierFromInputOutput(2, 10)
const COST_TIER_3_15: ModelCosts = tierFromInputOutput(3, 15)
const COST_TIER_15_75: ModelCosts = tierFromInputOutput(15, 75)
export const COST_TIER_5_25: ModelCosts = tierFromInputOutput(5, 25)
export const COST_TIER_10_50: ModelCosts = tierFromInputOutput(10, 50)
export const COST_FABLE_5_1: ModelCosts = {
  ...COST_TIER_10_50,
  promptCacheReadTokens: 0.25,
}
const COST_FABLE_5_2: ModelCosts = {
  ...tierFromInputOutput(8, 40),
  promptCacheReadTokens: 0.2,
}
export const COST_OPUS_5_5: ModelCosts = {
  ...tierFromInputOutput(4, 20),
  promptCacheReadTokens: 0.2,
}
const COST_SONNET_5_5: ModelCosts = { ...COST_TIER_2_10, promptCacheReadTokens: 0.1 }
const COST_HAIKU_35: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: WEB_SEARCH_PER_REQUEST,
}
const COST_HAIKU_45: ModelCosts = tierFromInputOutput(1, 5)
const COST_HAIKU_55: ModelCosts = tierFromInputOutput(0.1, 0.5)
const COST_HAIKU_55_LONG: ModelCosts = tierFromInputOutput(0.5, 2.5)

export const COST_LOCAL_SERVER: ModelCosts = {
  inputTokens: 0,
  outputTokens: 0,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
}

export const COST_UNPRICED: ModelCosts = { ...COST_LOCAL_SERVER }

export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  'claude-3-5-haiku': COST_HAIKU_35,
  'claude-haiku-4-5': COST_HAIKU_45,
  'claude-haiku-5-5': COST_HAIKU_55,
  'claude-3-5-sonnet': COST_TIER_3_15,
  'claude-3-7-sonnet': COST_TIER_3_15,
  'claude-sonnet-4': COST_TIER_3_15,
  'claude-sonnet-4-5': COST_TIER_3_15,
  'claude-sonnet-4-6': COST_TIER_3_15,
  'claude-sonnet-5': COST_TIER_2_10,
  'claude-sonnet-5-5': COST_SONNET_5_5,
  'claude-opus-4': COST_TIER_15_75,
  'claude-opus-4-1': COST_TIER_15_75,
  'claude-opus-4-5': COST_TIER_5_25,
  'claude-opus-4-6': COST_TIER_5_25,
  'claude-opus-5': COST_TIER_5_25,
  'claude-opus-5-5': COST_OPUS_5_5,
  'claude-fable-5': COST_TIER_10_50,
  'claude-fable-5-1': COST_FABLE_5_1,
  'claude-fable-5-2': COST_FABLE_5_2,
}

export const ANTHROPIC_PRICING_PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing'

export const ANTHROPIC_PRICE_OBSERVED_AT: Readonly<Partial<Record<ModelShortName, { observedAt: string; source: string }>>> = {
  'claude-3-5-haiku': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-haiku-4-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-haiku-5-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-sonnet-4': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-sonnet-4-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-sonnet-4-6': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-sonnet-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-sonnet-5-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-opus-4': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-opus-4-1': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-opus-4-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-opus-4-6': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-opus-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-opus-5-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-fable-5': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-fable-5-1': { observedAt: '2026-10-31', source: ANTHROPIC_PRICING_PAGE },
  'claude-fable-5-2': { observedAt: '2026-11-09', source: ANTHROPIC_PRICING_PAGE },
}

type UsageLike = {
  input_tokens: number
  output_tokens: number
  request_started_at_ms?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
  server_tool_use?: { web_search_requests?: number } | null
}

function engineTier(
  pin:
    | { costInPerMtok?: number; costOutPerMtok?: number; cachedInPerMtok?: number; cacheWritePerMtok?: number }
    | undefined,
): ModelCosts | undefined {
  if (!pin || pin.costInPerMtok === undefined || pin.costOutPerMtok === undefined) return undefined
  return {
    inputTokens: pin.costInPerMtok,
    outputTokens: pin.costOutPerMtok,
    promptCacheWriteTokens: pin.cacheWritePerMtok ?? pin.costInPerMtok,
    promptCacheReadTokens: pin.cachedInPerMtok ?? pin.costInPerMtok * 0.1,
    webSearchRequests: 0,
  }
}

const recorded = (costs: ModelCosts | undefined): ResolvedModelPricing | undefined =>
  costs === undefined ? undefined : { costs, basis: 'recorded' }

const FIRST_PARTY_FALLBACK_TIER: ModelCosts = COST_TIER_5_25

function firstPartyCosts(model: string, promptTokens: number | undefined): ModelCosts | undefined {
  const canonical = getCanonicalName(model)
  if (canonical === 'claude-haiku-5-5' && promptTokens !== undefined && promptTokens > 100_000) return COST_HAIKU_55_LONG
  return MODEL_COSTS[canonical]
}

function firstPartyPricing(model: string, promptTokens: number | undefined): ResolvedModelPricing {
  const tier = firstPartyCosts(model, promptTokens)
  if (tier) return { costs: tier, basis: 'recorded' }
  const head = familyHeadOf(model)
  const estimateFrom = head !== null ? ALL_MODEL_CONFIGS[head].firstParty : firstPartyDefaultSetting()
  if (estimateFrom !== undefined) {
    const fallback = firstPartyCosts(estimateFrom, promptTokens)
    if (fallback) return { costs: fallback, basis: 'family-estimate' }
  }
  return { costs: FIRST_PARTY_FALLBACK_TIER, basis: 'family-estimate' }
}

function firstPartyDefaultSetting(): string | undefined {
  const defaultModel = getDefaultEngineModelSetting()
  return typeof defaultModel === 'string' && declaredRouteOf(defaultModel) === 'anthropic' ? defaultModel : undefined
}

function perMtokFromPerToken(perToken: string | undefined): number | undefined {
  if (perToken === undefined) return undefined
  const value = Number(perToken)
  return Number.isFinite(value) && value >= 0 ? value * 1e6 : undefined
}

function openrouterCataloguePricing(model: string): ResolvedModelPricing | undefined {
  let listed: { pricing?: { prompt?: string; completion?: string; inputCacheRead?: string; inputCacheWrite?: string } } | undefined
  try {
    const { openrouterListedModel } =
      require('../providers/openrouter/openrouterCatalogue.js') as typeof import('../providers/openrouter/openrouterCatalogue.js')
    listed = openrouterListedModel(model)
  } catch (error) {
    passedOver(error)
    return undefined
  }
  const input = perMtokFromPerToken(listed?.pricing?.prompt)
  const output = perMtokFromPerToken(listed?.pricing?.completion)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = perMtokFromPerToken(listed?.pricing?.inputCacheRead)
  const cacheWrite = perMtokFromPerToken(listed?.pricing?.inputCacheWrite)
  return {
    costs: {
      inputTokens: input,
      outputTokens: output,
      promptCacheWriteTokens: cacheWrite ?? input,
      promptCacheReadTokens: cacheRead ?? input,
      webSearchRequests: 0,
    },
    basis: 'recorded',
  }
}

function nousCataloguePricing(model: string, promptTokens: number | undefined): ResolvedModelPricing | undefined {
  type Rates = { prompt?: string; completion?: string; inputCacheRead?: string; inputCacheWrite?: string }
  let listed: { pricing?: Rates & { overrides?: ReadonlyArray<Rates & { minPromptTokens: number }> } } | undefined
  try {
    const { nousListedModel } =
      require('../providers/nous/nousCatalogue.js') as typeof import('../providers/nous/nousCatalogue.js')
    listed = nousListedModel(model)
  } catch (error) {
    passedOver(error)
    return undefined
  }
  const base = listed?.pricing
  const tier = promptTokens === undefined
    ? undefined
    : (base?.overrides ?? []).filter(row => promptTokens >= row.minPromptTokens).sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0]
  const rate = (field: keyof Rates): number | undefined => {
    const value = perMtokFromPerToken(tier?.[field] ?? base?.[field])
    return value === undefined ? undefined : Number(value.toPrecision(12))
  }
  const input = rate('prompt')
  const output = rate('completion')
  if (input === undefined || output === undefined) return undefined
  const cacheRead = rate('inputCacheRead')
  const cacheWrite = rate('inputCacheWrite')
  return {
    costs: {
      inputTokens: input,
      outputTokens: output,
      promptCacheWriteTokens: cacheWrite ?? input,
      promptCacheReadTokens: cacheRead ?? input,
      webSearchRequests: 0,
    },
    basis: 'recorded',
  }
}

function huggingfaceFloorPricing(model: string): ResolvedModelPricing | undefined {
  const pin = huggingfaceDisplayPin(model)
  if (!pin || pin.priceFloorInPerMtok === undefined || pin.priceFloorOutPerMtok === undefined) return undefined
  const costs = engineTier({ costInPerMtok: pin.priceFloorInPerMtok, costOutPerMtok: pin.priceFloorOutPerMtok })
  return costs === undefined ? undefined : { costs, basis: 'floor' }
}

function utcDayOf(startedAtMs: number | undefined): string | undefined {
  const date = new Date(startedAtMs ?? NaN)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined
}

type PricingOwner = (model: string, promptTokens: number | undefined, startedAtMs: number | undefined) => ResolvedModelPricing | undefined

const PRICING_OWNERS: Record<CallModelRoute, PricingOwner> = {
  anthropic: (model, promptTokens) => firstPartyPricing(model, promptTokens),
  openai: (model, promptTokens, startedAtMs) => {
    const pin = gptDisplayPin(model)
    return pin === undefined ? undefined : recorded(engineTier(gptPriceTierFor(pin, promptTokens, utcDayOf(startedAtMs))))
  },
  zai: model => recorded(engineTier(glmPricePin(model))),
  moonshot: model => recorded(engineTier(kimiDisplayPin(model))),
  deepseek: model => recorded(engineTier(deepseekDisplayPin(model))),
  xai: (model, promptTokens) => {
    const pin = xaiModelFacts(model)
    return recorded(engineTier(pin?.longContext && promptTokens !== undefined && promptTokens >= (pin.longContextThreshold ?? Infinity) ? pin.longContext : pin))
  },
  meta: (model, promptTokens) => {
    const pin = metaDisplayPin(model)
    return recorded(engineTier(pin?.longContext && promptTokens !== undefined && promptTokens > (pin.longContextThreshold ?? Infinity) ? pin.longContext : pin))
  },
  gemini: (model, promptTokens, startedAtMs) => {
    const pin = geminiPricePin(model)
    return pin === undefined ? undefined : recorded(engineTier(geminiPriceTierFor(pin, promptTokens, utcDayOf(startedAtMs))))
  },
  openrouter: model => openrouterCataloguePricing(model),
  huggingface: model => huggingfaceFloorPricing(model),
  local: model => {
    const { localRecordFor } = require('../providers/local/localCatalogue.js') as typeof import('../providers/local/localCatalogue.js')
    const record = localRecordFor(model)
    return record === undefined || record.executionOrigin?.kind === 'remote' ? undefined : { costs: COST_LOCAL_SERVER, basis: 'recorded' }
  },
  'openai-compat': () => undefined,
  mistral: model => recorded(engineTier(mistralDisplayPin(model))),
  nous: (model, promptTokens) => nousCataloguePricing(model, promptTokens),
  zen: (model, promptTokens) => {
    const pin = zenDisplayPin(model)
    return recorded(engineTier(pin?.longContext && promptTokens !== undefined && promptTokens > (pin.longContextThreshold ?? Infinity) ? pin.longContext : pin))
  },
  minimax: (model, promptTokens) => {
    const pin = minimaxDisplayPin(model)
    return recorded(engineTier(pin?.longContext && promptTokens !== undefined && promptTokens > (pin.longContextThreshold ?? Infinity) ? { ...pin.longContext, cacheWritePerMtok: pin.cacheWritePerMtok } : pin))
  },
  together: model => recorded(engineTier(togetherDisplayPin(model))),
  cohere: model => recorded(engineTier(cohereDisplayPin(model))),
  groq: model => recorded(engineTier(groqDisplayPin(model))),
  melious: () => undefined,
  orcarouter: model => {
    const { orcarouterListedModel } = require('../providers/orcarouter/orcarouterCatalogue.js') as typeof import('../providers/orcarouter/orcarouterCatalogue.js')
    const price = orcarouterListedModel(model)?.pricing
    if (price?.prompt === undefined || price.completion === undefined) return undefined
    return recorded({ inputTokens: price.prompt * 1e6, outputTokens: price.completion * 1e6, promptCacheReadTokens: price.prompt * 1e6, promptCacheWriteTokens: price.prompt * 1e6, webSearchRequests: 0 })
  },
  cerebras: model => recorded(engineTier(cerebrasDisplayPin(model))),
  fireworks: model => recorded(engineTier(fireworksDisplayPin(model))),
  qwen: (model, promptTokens) => qwenResolvedPricing(model, promptTokens),
}

export function resolveModelPricing(model: string, opts?: { promptTokens?: number; startedAtMs?: number }): ResolvedModelPricing {
  const route = declaredRouteOf(model)
  const resolved = route === null ? undefined : PRICING_OWNERS[route](model, opts?.promptTokens, opts?.startedAtMs)
  let base: ResolvedModelPricing = resolved ?? { costs: COST_UNPRICED, basis: 'unpriced' }
  if (route === 'deepseek' && resolved !== undefined && opts?.startedAtMs !== undefined) {
    const period = deepseekRatePeriod(opts.startedAtMs)
    if (period === 'off-peak') {
      base = { basis: resolved.basis, costs: {
        inputTokens: resolved.costs.inputTokens / 2, outputTokens: resolved.costs.outputTokens / 2,
        promptCacheReadTokens: resolved.costs.promptCacheReadTokens / 2,
        promptCacheWriteTokens: resolved.costs.promptCacheWriteTokens / 2, webSearchRequests: resolved.costs.webSearchRequests,
      } }
    } else if (period === 'holiday-unknown') base = { ...resolved, basis: 'family-estimate' }
  }
  const prices = operatorModelFacts(model)?.prices
  if (!prices) return base
  return { costs: { ...base.costs, inputTokens: prices.input ?? base.costs.inputTokens, outputTokens: prices.output ?? base.costs.outputTokens,
    promptCacheReadTokens: prices.cacheRead ?? base.costs.promptCacheReadTokens, promptCacheWriteTokens: prices.cacheWrite ?? base.costs.promptCacheWriteTokens },
    basis: prices.input !== undefined && prices.output !== undefined ? 'recorded' : base.basis }
}

export function modelPricingBasis(model: string): PricingBasis {
  return resolveModelPricing(model).basis
}

export function getModelCosts(model: string, opts?: { promptTokens?: number; startedAtMs?: number }): ModelCosts {
  const resolved = resolveModelPricing(model, opts)
  if (resolved.basis !== 'recorded') setHasUnknownModelCost()
  return resolved.costs
}

export function calculateUSDCost(resolvedModel: string, usage: UsageLike): number {
  const input = usageCount(usage.input_tokens)
  const output = usageCount(usage.output_tokens)
  const reads = usageCount(usage.cache_read_input_tokens)
  const writes = usageCount(usage.cache_creation_input_tokens)
  const hour = Math.min(writes, usageCount(usage.cache_creation?.ephemeral_1h_input_tokens))
  const searches = usageCount(usage.server_tool_use?.web_search_requests)
  const costs = getModelCosts(resolvedModel, { promptTokens: input + reads + writes, startedAtMs: usage.request_started_at_ms })
  const hourPrice = operatorModelFacts(resolvedModel)?.prices?.cacheWrite ?? 2 * costs.inputTokens
  return input * costs.inputTokens / 1_000_000 +
    output * costs.outputTokens / 1_000_000 +
    reads * costs.promptCacheReadTokens / 1_000_000 +
    (writes - hour) * costs.promptCacheWriteTokens / 1_000_000 +
    hour * hourPrice / 1_000_000 + searches * costs.webSearchRequests
}

export function calculateCostFromTokens(
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number },
): number {
  return calculateUSDCost(model, {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  })
}

export function formatModelPricing(costs: ModelCosts): string {
  const price = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
  return `${price(costs.inputTokens)}/${price(costs.outputTokens)} per Mtok`
}

export function getModelPricingString(model: string): string | undefined {
  const route = declaredRouteOf(model)
  if (route === 'melious') {
    const { meliousPricingString } = require('../providers/melious/meliousCatalogue.js') as typeof import('../providers/melious/meliousCatalogue.js')
    return meliousPricingString(model)
  }
  if (route === 'qwen' && qwenRegionalPrice(model)) return formatModelPricing(resolveModelPricing(model).costs)
  const pricing = resolveModelPricing(model)
  return pricing.basis === 'recorded' || pricing.basis === 'floor' ? formatModelPricing(pricing.costs) : undefined
}
