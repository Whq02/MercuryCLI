import type { CallModelRoute } from '../roads/routeLaw.js'
import { GPT_DISPLAY_PINS, gptDisplayName, parseGptModelId } from '../facts/pins/gptPins.js'
import { frontierOperatorDecision } from './frontierPolicy.js'
import {
  getDefaultSonnetModel,
  getMarketingNameForModel,
} from './engineModel.js'
import { keyLanePins } from './modelOptions.js'
import { moonshotCatalogueSourceWords } from '../roads/moonshot/moonshotCatalogue.js'
import { deepseekCatalogueSourceWords } from '../roads/deepseek/deepseekCatalogue.js'
import { zaiCatalogueSourceWords } from '../roads/zai/zaiCatalogue.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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
      case 'xai': {
        const { xaiCatalogueRows } = require('../roads/xai/xaiCatalogue.js') as typeof import('../roads/xai/xaiCatalogue.js')
        const row = xaiCatalogueRows().rows[0]
        return row ? { modelId: row.id, displayName: row.displayName } : undefined
      }
      case 'meta': {
        const { newestMetaModel, metaCatalogueRows } = require('../roads/meta/metaCatalogue.js') as typeof import('../roads/meta/metaCatalogue.js')
        const row = metaCatalogueRows().rows.find(row => row.id === newestMetaModel())
        return row ? { modelId: row.id, displayName: row.displayName } : undefined
      }
      case 'mistral': {
        const { mistralCatalogueRows } = require('../roads/mistral/mistralCatalogue.js') as typeof import('../roads/mistral/mistralCatalogue.js')
        const row = mistralCatalogueRows().rows[0]
        return row ? { modelId: row.id, displayName: row.displayName } : undefined
      }
      case 'zai':
      case 'moonshot':
      case 'deepseek': {
        const pin = keyLanePins(route)[0]
        if (!pin) return undefined
        const liveWords = route === 'deepseek' ? deepseekCatalogueSourceWords() : route === 'moonshot' ? moonshotCatalogueSourceWords() : zaiCatalogueSourceWords()
        if (liveWords !== undefined) return { modelId: pin.id, displayName: pin.displayName }
        return { modelId: pin.id, displayName: pin.displayName, observedAt: pin.observedAt }
      }
      case 'gemini':
      case 'openrouter':
      case 'openai-compat':
      case 'local':
      case 'zen':
      case 'together':
      case 'groq':
      case 'melious':
      case 'orcarouter':
      case 'cerebras':
      case 'fireworks':
        return undefined
      case 'minimax': {
        const { minimaxCatalogueRows } = require('../roads/minimax/minimaxCatalogue.js') as typeof import('../roads/minimax/minimaxCatalogue.js')
        const row = minimaxCatalogueRows().rows[0]
        return row ? { modelId: row.id, displayName: row.displayName } : undefined
      }
      case 'cohere': {
        const { cohereCatalogueRows } = require('../roads/cohere/cohereCatalogue.js') as typeof import('../roads/cohere/cohereCatalogue.js')
        const row = cohereCatalogueRows().rows[0]
        return row ? { modelId: row.id, displayName: row.displayName } : undefined
      }
      case 'qwen': {
        const { qwenCatalogueRows } = require('../roads/qwen/qwenCatalogue.js') as typeof import('../roads/qwen/qwenCatalogue.js')
        const row = qwenCatalogueRows().rows[0]
        return row ? { modelId: row.id, displayName: row.displayName } : undefined
      }
      case 'huggingface': {
        const { getCachedHuggingfaceCatalogue } =
          require('../roads/huggingface/huggingfaceCatalogue.js') as typeof import('../roads/huggingface/huggingfaceCatalogue.js')
        const live = getCachedHuggingfaceCatalogue()?.models[0]
        if (live) {
          const { huggingfaceSlugModelName } =
            require('../facts/pins/huggingfacePins.js') as typeof import('../facts/pins/huggingfacePins.js')
          return { modelId: `huggingface/${live.id}`, displayName: huggingfaceSlugModelName(live.id) }
        }
        const { HUGGINGFACE_DISPLAY_PINS } =
          require('../facts/pins/huggingfacePins.js') as typeof import('../facts/pins/huggingfacePins.js')
        const pin = HUGGINGFACE_DISPLAY_PINS[0]
        if (!pin) return undefined
        return { modelId: `huggingface/${pin.id}`, displayName: pin.displayName, observedAt: pin.observedAt }
      }
      case 'nous': {
        const { getNousModelOptions, NOUS_MODEL_PREFIX } =
          require('../roads/nous/nousCatalogue.js') as typeof import('../roads/nous/nousCatalogue.js')
        const row = getNousModelOptions().find(option => option.value.startsWith(NOUS_MODEL_PREFIX) && option.unavailable === undefined)
        return row ? { modelId: row.value, displayName: row.label } : undefined
      }
    }
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

type GptRank = { id: string; major: number; minor: number }

function newerThan(a: GptRank, b: GptRank): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor)
}

const OPENAI_SESSION_TIER = 'sol'

export function openaiSessionDefault(served: readonly string[]): ProviderFrontierFact | undefined {
  const general: Array<GptRank & { variant: string; pin: (typeof GPT_DISPLAY_PINS)[number] }> = []
  for (const pin of GPT_DISPLAY_PINS) {
    const identity = parseGptModelId(pin.id)
    if (identity && pin.variantKind === undefined && pin.status !== 'deprecated' && served.includes(pin.id)) general.push({ id: pin.id, major: identity.major, minor: identity.minor, variant: identity.variant, pin })
  }
  let newest: GptRank | undefined
  for (const row of general) if (newest === undefined || newerThan(row, newest)) newest = row
  if (newest === undefined) return undefined
  const release = general.filter(row => row.major === newest.major && row.minor === newest.minor)
  const pick = release.find(row => row.variant === OPENAI_SESSION_TIER) ?? release[0]!
  return { modelId: pick.pin.id, displayName: pick.pin.displayName, observedAt: pick.pin.observedAt }
}

function openaiServedIds(): string[] | undefined {
  const { resolveOpenaiAccount } =
    require('../roads/openai/openaiAccounts.js') as typeof import('../roads/openai/openaiAccounts.js')
  const { qualifiedGptCandidates } =
    require('../roads/openai/openaiCatalogue.js') as typeof import('../roads/openai/openaiCatalogue.js')
  const account = resolveOpenaiAccount()
  if (!account) return undefined
  return qualifiedGptCandidates('specialist', account.kind).map(candidate => candidate.identity.canonicalId)
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
  } catch (error) {
    passedOver(error)
    return undefined
  }
}
