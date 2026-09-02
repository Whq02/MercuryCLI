import { declaredRouteOf, type CallModelRoute } from '../../services/providers/routeLaw.js'
import { GPT_DISPLAY_PINS, parseGptModelId } from '../../services/providers/openai/gptPins.js'
import { frontierOperatorDecision } from './frontierPolicy.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getMarketingNameForModel,
  getSmallFastModel,
} from './model.js'
import { keyLanePins } from './modelOptions.js'

export interface ProviderFrontierFact {
  modelId: string
  displayName: string
  observedAt?: string
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
        if (!ceiling) return undefined
        let best: { pin: (typeof GPT_DISPLAY_PINS)[number]; major: number; minor: number } | undefined
        for (const pin of GPT_DISPLAY_PINS) {
          const identity = parseGptModelId(pin.id)
          if (!identity || identity.variant !== '') continue
          const below =
            identity.major < ceiling.major ||
            (identity.major === ceiling.major && identity.minor < ceiling.minor)
          if (!below) continue
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
        let best:
          | { pin: (typeof GPT_DISPLAY_PINS)[number]; major: number; minor: number }
          | undefined
        for (const pin of GPT_DISPLAY_PINS) {
          if (pin.availabilityNote !== undefined) continue
          const identity = parseGptModelId(pin.id)
          if (!identity || (identity.variant !== 'mini' && identity.variant !== 'nano')) continue
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
  return `frontier: ${fact.displayName}${fact.observedAt ? ` · ${fact.observedAt}` : ''}`
}
