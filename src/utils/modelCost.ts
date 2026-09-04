import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { deepseekDisplayPin } from '../services/providers/deepseek/deepseekPins.js'
import { geminiPricePin, geminiPriceTierFor } from '../services/providers/gemini/geminiPins.js'
import { huggingfaceDisplayPin } from '../services/providers/huggingface/huggingfacePins.js'
import type { CallModelRoute } from '../services/providers/idSpaces.js'
import { kimiDisplayPin } from '../services/providers/moonshot/kimiPins.js'
import { gptDisplayPin } from '../services/providers/openai/gptPins.js'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { glmPricePin } from '../services/providers/zai/glmPins.js'
import { getCanonicalName, getDefaultMainLoopModelSetting, type ModelShortName } from './model/model.js'


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

export const COST_TIER_3_15: ModelCosts = tierFromInputOutput(3, 15)
export const COST_TIER_15_75: ModelCosts = tierFromInputOutput(15, 75)
export const COST_TIER_5_25: ModelCosts = tierFromInputOutput(5, 25)
export const COST_TIER_10_50: ModelCosts = tierFromInputOutput(10, 50)
export const COST_FABLE_5_1: ModelCosts = {
  ...COST_TIER_10_50,
  promptCacheReadTokens: 0.25,
}
export const COST_HAIKU_35: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: WEB_SEARCH_PER_REQUEST,
}
export const COST_HAIKU_45: ModelCosts = tierFromInputOutput(1, 5)

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
  'claude-3-5-sonnet': COST_TIER_3_15,
  'claude-3-7-sonnet': COST_TIER_3_15,
  'claude-sonnet-4': COST_TIER_3_15,
  'claude-sonnet-4-5': COST_TIER_3_15,
  'claude-sonnet-4-6': COST_TIER_3_15,
  'claude-sonnet-5': COST_TIER_3_15,
  'claude-opus-4': COST_TIER_15_75,
  'claude-opus-4-1': COST_TIER_15_75,
  'claude-opus-4-5': COST_TIER_5_25,
  'claude-opus-4-6': COST_TIER_5_25,
  'claude-opus-5': COST_TIER_5_25,
  'claude-fable-5': COST_TIER_10_50,
  'claude-fable-5-1': COST_FABLE_5_1,
}

type UsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
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

function firstPartyPricing(model: string): ResolvedModelPricing {
  const tier = MODEL_COSTS[getCanonicalName(model)]
  if (tier) return { costs: tier, basis: 'recorded' }
  const defaultModel = getDefaultMainLoopModelSetting()
  if (typeof defaultModel === 'string' && declaredRouteOf(defaultModel) === 'anthropic') {
    const fallback = MODEL_COSTS[getCanonicalName(defaultModel)]
    if (fallback) return { costs: fallback, basis: 'family-estimate' }
  }
  return { costs: FIRST_PARTY_FALLBACK_TIER, basis: 'family-estimate' }
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
      require('../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../services/providers/openrouter/openrouterCatalogue.js')
    listed = openrouterListedModel(model)
  } catch {
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

function huggingfaceFloorPricing(model: string): ResolvedModelPricing | undefined {
  const pin = huggingfaceDisplayPin(model)
  if (!pin || pin.priceFloorInPerMtok === undefined || pin.priceFloorOutPerMtok === undefined) return undefined
  const costs = engineTier({ costInPerMtok: pin.priceFloorInPerMtok, costOutPerMtok: pin.priceFloorOutPerMtok })
  return costs === undefined ? undefined : { costs, basis: 'floor' }
}

type PricingOwner = (model: string, promptTokens: number | undefined) => ResolvedModelPricing | undefined

const PRICING_OWNERS: Record<CallModelRoute, PricingOwner> = {
  anthropic: model => firstPartyPricing(model),
  openai: model => recorded(engineTier(gptDisplayPin(model))),
  zai: model => recorded(engineTier(glmPricePin(model))),
  moonshot: model => recorded(engineTier(kimiDisplayPin(model))),
  deepseek: model => recorded(engineTier(deepseekDisplayPin(model))),
  gemini: (model, promptTokens) => {
    const pin = geminiPricePin(model)
    return pin === undefined ? undefined : recorded(engineTier(geminiPriceTierFor(pin, promptTokens)))
  },
  openrouter: model => openrouterCataloguePricing(model),
  huggingface: model => huggingfaceFloorPricing(model),
  local: () => ({ costs: COST_LOCAL_SERVER, basis: 'recorded' }),
  'openai-compat': () => undefined,
}

export function resolveModelPricing(model: string, opts?: { promptTokens?: number }): ResolvedModelPricing {
  const route = declaredRouteOf(model)
  const resolved = route === null ? undefined : PRICING_OWNERS[route](model, opts?.promptTokens)
  return resolved ?? { costs: COST_UNPRICED, basis: 'unpriced' }
}

export function modelPricingBasis(model: string): PricingBasis {
  return resolveModelPricing(model).basis
}

export function getModelCosts(model: string, opts?: { promptTokens?: number }): ModelCosts {
  const resolved = resolveModelPricing(model, opts)
  if (resolved.basis !== 'recorded') setHasUnknownModelCost()
  return resolved.costs
}

export function calculateUSDCost(resolvedModel: string, usage: UsageLike): number {
  const cacheCreation = usage.cache_creation_input_tokens ?? 0
  const promptTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + cacheCreation
  const modelCosts = getModelCosts(resolvedModel, { promptTokens })
  const reported1h = usage.cache_creation?.ephemeral_1h_input_tokens
  const oneHour = reported1h !== undefined ? Math.min(reported1h, cacheCreation) : 0
  const fiveMinute = cacheCreation - oneHour
  return (
    (usage.input_tokens * modelCosts.inputTokens) / 1e6 +
    (usage.output_tokens * modelCosts.outputTokens) / 1e6 +
    ((usage.cache_read_input_tokens ?? 0) * modelCosts.promptCacheReadTokens) / 1e6 +
    (fiveMinute * modelCosts.promptCacheWriteTokens) / 1e6 +
    (oneHour * (modelCosts.inputTokens * 2)) / 1e6 +
    (usage.server_tool_use?.web_search_requests ?? 0) * modelCosts.webSearchRequests
  )
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

function formatPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`
}

export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

export function getModelPricingString(model: string): string | undefined {
  const resolved = resolveModelPricing(model)
  return resolved.basis === 'recorded' || resolved.basis === 'floor' ? formatModelPricing(resolved.costs) : undefined
}
