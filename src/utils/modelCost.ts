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

/**
 * Per-model price tiers and USD cost computation from token usage. Prices
 * are USD per million tokens; web search is per request.
 *
 * ONE PRICING OWNER PER PROVIDER (the usage-neutrality law): the routing
 * law names the family a model id belongs to, and that family's own owner
 * — its published-rate table — answers for it. No family ever prices
 * another family's turn. Where the family's owner records no rate for the
 * id, the ledger still lands the tokens and says the USD is unrecorded
 * (basis 'unpriced', a zero figure under the unknown-cost flag) — never a
 * neighbour's tier dressed as a price. The one wire-stated price (an
 * OpenRouter response's own cost) is applied by the lane at its settlement
 * and never reaches this module.
 */

export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

/**
 * How a model's USD was arrived at:
 *   · 'recorded'        — the provider's own published rate for this id (a
 *                         local server's recorded zero counts);
 *   · 'floor'           — the LOWEST rate the provider's surface lists for
 *                         this id (Hugging Face routes to partner providers
 *                         at their own rates; the floor is below or equal to
 *                         the bill) — an estimate, flagged;
 *   · 'family-estimate' — a first-party id with no recorded rate, priced at
 *                         the default first-party tier — an estimate, flagged;
 *   · 'unpriced'        — no rate on file for this id: the tokens land, the
 *                         USD is zero, the unknown-cost flag is raised and the
 *                         lane's spend view says so.
 */
export type PricingBasis = 'recorded' | 'floor' | 'family-estimate' | 'unpriced'

export interface ResolvedModelPricing {
  costs: ModelCosts
  basis: PricingBasis
}

const WEB_SEARCH_PER_REQUEST = 0.01

/** The standard ratios: cache write 1.25× input, cache read 0.1× input. */
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
/** Claude Fable 5.1: the Fable tier with cache reads at 0.025× input
 *  ($0.25/MTok — the pricing page, fetched 2026-09-01); writes unchanged. */
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

/** A local server bills nothing: the operator's own machine serves the
 *  model, and there is no vendor invoice to estimate. A recorded price of
 *  zero — not an unknown cost (FN-018 rank 3: local turns were priced at
 *  an Anthropic tier and flagged, $0.635 for a request that cost $0). */
export const COST_LOCAL_SERVER: ModelCosts = {
  inputTokens: 0,
  outputTokens: 0,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
}

/** No rate on file: the tokens are counted, the USD is zero, and the basis
 *  says so — never a silent figure and never another vendor's. */
export const COST_UNPRICED: ModelCosts = { ...COST_LOCAL_SERVER }

/** Keyed by canonical short name (Mythos folds onto the Fable canonical, so one entry covers both). */
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

/**
 * A pinned third-party engine takes the pin's exact documented cached-input
 * rate when stated (else a tenth of input), and a cache-WRITE rate equal to
 * the input rate: that provider charges nothing extra to populate its prefix
 * cache (a mark-up would be an invented price), and its responses carry no
 * cache-creation count anyway. No pin records a per-search rate; the
 * hosted-search COUNT rides the usage envelope (the openai lane sets it)
 * while its price waits for a recorded rate — absent beats invented, and
 * the first-party per-request figure is another vendor's price (FN-018
 * rank 18). A pin without a RECORDED price is not a price of zero — it
 * resolves as unpriced.
 */
function engineTier(
  pin: { costInPerMtok?: number; costOutPerMtok?: number; cachedInPerMtok?: number } | undefined,
): ModelCosts | undefined {
  if (!pin || pin.costInPerMtok === undefined || pin.costOutPerMtok === undefined) return undefined
  return {
    inputTokens: pin.costInPerMtok,
    outputTokens: pin.costOutPerMtok,
    promptCacheWriteTokens: pin.costInPerMtok,
    promptCacheReadTokens: pin.cachedInPerMtok ?? pin.costInPerMtok * 0.1,
    webSearchRequests: 0,
  }
}

const recorded = (costs: ModelCosts | undefined): ResolvedModelPricing | undefined =>
  costs === undefined ? undefined : { costs, basis: 'recorded' }

/** The first-party family's own estimate for an id its table does not
 *  record when the default main-loop model is not first-party either: the
 *  Opus 4.5/4.6 tier. Spent inside firstPartyPricing ALONE — no other owner
 *  row can reach a first-party tier by construction (the prover reads the
 *  owners table for exactly that), so a non-first-party turn never prices
 *  at a foreign rate, flagged or not. */
const FIRST_PARTY_FALLBACK_TIER: ModelCosts = COST_TIER_5_25

/** The first-party family's own table; an id it does not record prices at
 *  the default first-party tier (the default main-loop model's, when that
 *  default is itself first-party, else FIRST_PARTY_FALLBACK_TIER) — a
 *  same-vendor estimate, flagged as one. */
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

/** A USD-per-token string the OpenRouter catalogue states, as USD per
 *  million; undefined for an unstated or unparsable cell. */
function perMtokFromPerToken(perToken: string | undefined): number | undefined {
  if (perToken === undefined) return undefined
  const value = Number(perToken)
  return Number.isFinite(value) && value >= 0 ? value * 1e6 : undefined
}

/** The OpenRouter family's owner: the ACTIVE credential's cached catalogue
 *  row (pricing.prompt / completion, USD per token — the vendor's own
 *  figures for exactly the slug that ran; cache read/write where stated).
 *  Unfetched, unlisted or priceless rows are unpriced. The per-response
 *  stated cost still wins at the lane's settlement. */
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

/** The Hugging Face family's owner: the router bills the partner provider's
 *  own rate with no markup and states no per-request cost, so the recorded
 *  price FLOOR (the lowest listed provider rate for the slug) is the closest
 *  published figure — an estimate at or below the bill, flagged as one. */
function huggingfaceFloorPricing(model: string): ResolvedModelPricing | undefined {
  const pin = huggingfaceDisplayPin(model)
  if (!pin || pin.priceFloorInPerMtok === undefined || pin.priceFloorOutPerMtok === undefined) return undefined
  const costs = engineTier({ costInPerMtok: pin.priceFloorInPerMtok, costOutPerMtok: pin.priceFloorOutPerMtok })
  return costs === undefined ? undefined : { costs, basis: 'floor' }
}

type PricingOwner = (model: string, promptTokens: number | undefined) => ResolvedModelPricing | undefined

/** THE table: one owner per route the routing law declares. Adding a family
 *  to the router without a row here is a type error — no family is ever
 *  priced by another's owner. */
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
  // A custom endpoint publishes no rate Mercury could record — unpriced.
  'openai-compat': () => undefined,
}

/**
 * Resolve a model's pricing through its family's owner. Pure: no flag is
 * raised here (the ledger's cost computation raises it). `promptTokens` —
 * every input-side token the request sent — selects a longer-prompt tier
 * where the owner states one. An id no family declares has no owner and is
 * unpriced.
 */
export function resolveModelPricing(model: string, opts?: { promptTokens?: number }): ResolvedModelPricing {
  const route = declaredRouteOf(model)
  const resolved = route === null ? undefined : PRICING_OWNERS[route](model, opts?.promptTokens)
  return resolved ?? { costs: COST_UNPRICED, basis: 'unpriced' }
}

/** The pricing basis alone (pure) — the spend views mark estimated and
 *  unpriced models from this. */
export function modelPricingBasis(model: string): PricingBasis {
  return resolveModelPricing(model).basis
}

/**
 * The tier a model's USD is computed from. Every basis other than
 * 'recorded' raises the unknown-cost flag so the headline caveat prints;
 * the per-lane spend views carry the finer word.
 */
export function getModelCosts(model: string, opts?: { promptTokens?: number }): ModelCosts {
  const resolved = resolveModelPricing(model, opts)
  if (resolved.basis !== 'recorded') setHasUnknownModelCost()
  return resolved.costs
}

/**
 * When a per-TTL breakdown is reported, the one-hour portion is that figure
 * CLAMPED to the total and the five-minute portion is the remainder; without
 * a breakdown the whole creation count is charged at the flat write rate.
 * The one-hour premium is double the input rate (the extended-TTL price).
 */
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

/** For side queries that track counts independently. */
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

/** The exact shape is prover-pinned: `$<in>/$<out> per Mtok`. */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/** The display string through the same per-family owner the ledger uses
 *  (a recorded rate or a listed floor); nothing for an unpriced or
 *  estimated id — the display never shows a figure the ledger only guessed. */
export function getModelPricingString(model: string): string | undefined {
  const resolved = resolveModelPricing(model)
  return resolved.basis === 'recorded' || resolved.basis === 'floor' ? formatModelPricing(resolved.costs) : undefined
}
