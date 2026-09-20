import { declaredRouteOf, type CallModelRoute } from '../../services/providers/routeLaw.js'
import { GPT_DISPLAY_PINS, gptDisplayName, parseGptModelId, type GptDisplayPin } from '../../services/providers/openai/gptPins.js'
import { frontierOperatorDecision } from './frontierPolicy.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getMarketingNameForModel,
  getSmallFastModel,
} from './model.js'
import { keyLanePins } from './modelOptions.js'
import { moonshotCatalogueSourceWords } from '../../services/providers/moonshot/moonshotCatalogue.js'
import { deepseekCatalogueSourceWords } from '../../services/providers/deepseek/deepseekCatalogue.js'

export interface ProviderFrontierFact {
  modelId: string
  displayName: string
  observedAt?: string
  source?: string
}

export function providerFrontierFact(route: CallModelRoute): ProviderFrontierFact | undefined {
  try {
    switch (route) {
      case 'anthropic': {
        const decision = frontierOperatorDecision()
        const aware = decision.candidates[0]
        if (!aware) return undefined
        return {
          modelId: aware.id,
          displayName: getMarketingNameForModel(aware.id) ?? aware.id,
        }
      }
      case 'openai': {
        let best: { pin: (typeof GPT_DISPLAY_PINS)[number]; major: number; minor: number } | undefined
        for (const pin of GPT_DISPLAY_PINS) {
          const identity = parseGptModelId(pin.id)
          if (!identity) continue
          if (
            best === undefined ||
            identity.major > best.major ||
            (identity.major === best.major && identity.minor > best.minor)
          ) {
            best = { pin, major: identity.major, minor: identity.minor }
          }
        }
        if (!best) return undefined
        return { modelId: best.pin.id, displayName: best.pin.displayName, observedAt: best.pin.observedAt }
      }
      case 'zai':
      case 'moonshot':
      case 'deepseek': {
        const pin = keyLanePins(route)[0]
        if (!pin) return undefined
        const liveWords = route === 'deepseek' ? deepseekCatalogueSourceWords() : route === 'moonshot' ? moonshotCatalogueSourceWords() : undefined
        if (liveWords !== undefined) return { modelId: pin.id, displayName: pin.displayName, source: liveWords }
        return { modelId: pin.id, displayName: pin.displayName, observedAt: pin.observedAt }
      }
      case 'gemini':
      case 'openrouter':
      case 'openai-compat':
      case 'local':
        return undefined
      case 'huggingface': {
        const { getCachedHuggingfaceCatalogue } =
          require('../../services/providers/huggingface/huggingfaceCatalogue.js') as typeof import('../../services/providers/huggingface/huggingfaceCatalogue.js')
        const live = getCachedHuggingfaceCatalogue()?.models[0]
        if (live) {
          const { huggingfaceSlugModelName } =
            require('../../services/providers/huggingface/huggingfacePins.js') as typeof import('../../services/providers/huggingface/huggingfacePins.js')
          return { modelId: `huggingface/${live.id}`, displayName: huggingfaceSlugModelName(live.id) }
        }
        const { HUGGINGFACE_DISPLAY_PINS } =
          require('../../services/providers/huggingface/huggingfacePins.js') as typeof import('../../services/providers/huggingface/huggingfacePins.js')
        const pin = HUGGINGFACE_DISPLAY_PINS[0]
        if (!pin) return undefined
        return { modelId: `huggingface/${pin.id}`, displayName: pin.displayName, observedAt: pin.observedAt }
      }
    }
  } catch {
    return undefined
  }
}

type GptRank = { id: string; major: number; minor: number }

function newerThan(a: GptRank, b: GptRank): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor)
}

function openaiServedIds(): string[] | undefined {
  const { resolveOpenaiAccount } =
    require('../../services/providers/openai/openaiAccounts.js') as typeof import('../../services/providers/openai/openaiAccounts.js')
  const { qualifiedGptCandidates } =
    require('../../services/providers/openai/openaiCatalogue.js') as typeof import('../../services/providers/openai/openaiCatalogue.js')
  const account = resolveOpenaiAccount()
  if (!account) return undefined
  return qualifiedGptCandidates('specialist', account.kind).map(candidate => candidate.identity.canonicalId)
}

export function openaiSmallFastChoice(served: readonly string[], pins: readonly GptDisplayPin[] = GPT_DISPLAY_PINS): string | undefined {
  let best: (GptRank & { price: number; out: number }) | undefined
  for (const raw of served) {
    const identity = parseGptModelId(raw)
    if (!identity) continue
    const pin = pins.find(candidate => candidate.id === identity.canonicalId)
    const small = identity.variant === 'mini' || identity.variant === 'nano'
    const price = pin?.costInPerMtok ?? (small ? -1 : undefined)
    if (price === undefined) continue
    const row = { id: identity.canonicalId, major: identity.major, minor: identity.minor, price, out: pin?.costOutPerMtok ?? -1 }
    const cheaper =
      best === undefined ||
      row.price < best.price ||
      (row.price === best.price && (row.out < best.out || (row.out === best.out && newerThan(row, best))))
    if (cheaper) best = row
  }
  return best?.id
}

export function openaiLightChoice(served: readonly string[], ceiling: { major: number; minor: number } | undefined): string | undefined {
  if (!ceiling) return undefined
  let best: GptRank | undefined
  for (const raw of served) {
    const identity = parseGptModelId(raw)
    if (!identity || identity.variant !== '') continue
    const below = identity.major < ceiling.major || (identity.major === ceiling.major && identity.minor < ceiling.minor)
    if (!below) continue
    const row = { id: identity.canonicalId, major: identity.major, minor: identity.minor }
    if (best === undefined || newerThan(row, best)) best = row
  }
  return best?.id
}

export function providerLightFact(route: CallModelRoute): ProviderFrontierFact | undefined {
  try {
    switch (route) {
      case 'anthropic': {
        const modelId = getDefaultSonnetModel()
        return { modelId, displayName: getMarketingNameForModel(modelId) ?? modelId }
      }
      case 'openai': {
        const frontier = providerFrontierFact('openai')
        const ceiling = frontier ? parseGptModelId(frontier.modelId) : undefined
        const served = openaiServedIds()
        if (!ceiling || !served) return undefined
        const modelId = openaiLightChoice(served, ceiling)
        if (!modelId) return undefined
        return { modelId, displayName: gptDisplayName(modelId) ?? modelId }
      }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

export function providerSmallFastFact(route: CallModelRoute): ProviderFrontierFact | undefined {
  try {
    switch (route) {
      case 'anthropic': {
        const modelId = getSmallFastModel()
        return { modelId, displayName: getMarketingNameForModel(modelId) ?? modelId }
      }
      case 'openai': {
        const served = openaiServedIds()
        if (!served) return undefined
        const modelId = openaiSmallFastChoice(served, GPT_DISPLAY_PINS)
        if (!modelId) return undefined
        return { modelId, displayName: gptDisplayName(modelId) ?? modelId }
      }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

export function smallFastModelFor(sessionModel: string): string {
  const route = declaredRouteOf(sessionModel)
  if (route === 'anthropic') return getSmallFastModel()
  if (route === null) return sessionModel
  return providerSmallFastFact(route)?.modelId ?? sessionModel
}

export function sessionSmallFastModel(): string {
  return smallFastModelFor(getMainLoopModel())
}

export function sessionLightModel(): string {
  const sessionModel = getMainLoopModel()
  const route = declaredRouteOf(sessionModel)
  if (route === 'anthropic') return getDefaultSonnetModel()
  if (route === null) return sessionModel
  return providerLightFact(route)?.modelId ?? sessionModel
}

export function providerFrontierLine(route: CallModelRoute): string | undefined {
  const fact = providerFrontierFact(route)
  if (!fact) return undefined
  const detail = fact.source ?? fact.observedAt
  return `frontier: ${fact.displayName}${detail ? ` · ${detail}` : ''}`
}
