import { getInitialSettings } from '../settings/settings.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import { getCanonicalName } from './modelNames.js'
import { ALL_MODEL_CONFIGS, familyHeadOf } from './configs.js'
import { bareModelIdOf, bareFamilyWordOfRoute } from './bareFamilyWords.js'

export interface OperatorModelFacts {
  contextWindow?: number
  maxOutputTokens?: number
  prices?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  efforts?: string[]
  images?: boolean
  reasoning?: boolean
  thinkingBudget?: number
}

export function modelHasRecordedFacts(model: string): boolean {
  model = bareModelIdOf(model)
  switch (declaredRouteOf(model)) {
    case 'anthropic': return familyHeadOf(model) === null && Object.values(ALL_MODEL_CONFIGS).some(row => row.firstParty === getCanonicalName(model))
    case 'openai': return Boolean(require('./pins/gptPins.js').gptDisplayPin(model))
    case 'zai': return Boolean(require('./pins/glmPins.js').glmDisplayPin(model))
    case 'moonshot': return Boolean(require('./pins/kimiPins.js').kimiDisplayPin(model))
    case 'deepseek': return Boolean(require('./pins/deepseekPins.js').deepseekDisplayPin(model))
    case 'xai': return Boolean(require('./pins/xaiPins.js').xaiDisplayPin(model))
    case 'meta': return Boolean(require('./pins/metaPins.js').metaDisplayPin(model))
    case 'mistral': return Boolean(require('./pins/mistralPins.js').mistralDisplayPin(model))
    case 'gemini': return Boolean(require('./pins/geminiPins.js').geminiPricePin(model))
    case 'huggingface': return Boolean(require('./pins/huggingfacePins.js').huggingfaceDisplayPin(model.replace(/^huggingface\//, '')))
    case 'zen': return Boolean(require('./pins/zenPins.js').zenDisplayPin(model))
    case 'minimax': return Boolean(require('./pins/minimaxPins.js').minimaxDisplayPin(model))
    case 'together': return Boolean(require('./pins/togetherPins.js').togetherDisplayPin(model))
    case 'cohere': return Boolean(require('./pins/coherePins.js').cohereDisplayPin(model))
    case 'qwen': return Boolean(require('./pins/qwenPins.js').qwenDisplayPin(model))
    case 'groq': return Boolean(require('./pins/groqPins.js').groqDisplayPin(model))
    case 'melious': return Boolean(require('../../services/providers/melious/meliousCatalogue.js').meliousListedModel(model))
    case 'orcarouter': return Boolean(require('../../services/providers/orcarouter/orcarouterCatalogue.js').orcarouterListedModel(model))
    case 'cerebras': return Boolean(require('./pins/cerebrasPins.js').cerebrasDisplayPin(model))
    case 'fireworks': return Boolean(require('./pins/fireworksPins.js').fireworksDisplayPin(model))
    default: {
      const route = declaredRouteOf(model)
      return route !== null && bareFamilyWordOfRoute(route)?.knownRow(model) !== undefined
    }
  }
}

export function operatorModelFacts(model: string, recorded: OperatorModelFacts = {}): OperatorModelFacts | undefined {
  const table = getInitialSettings().models
  if (!table) return undefined
  const bare = bareModelIdOf(model)
  const explicit = Object.entries(table).find(([id]) => id !== '_default' && id.toLowerCase() === bare.toLowerCase())?.[1] as OperatorModelFacts | undefined
  const route = declaredRouteOf(model)
  const defaults = table._default !== undefined && !modelHasRecordedFacts(model) && route !== null ? (table._default as Record<string, OperatorModelFacts> | undefined)?.[route] : undefined
  if (!explicit && !defaults) return undefined
  const gaps = { ...defaults }
  for (const key of ['contextWindow', 'maxOutputTokens', 'efforts', 'images', 'reasoning', 'thinkingBudget'] as const) {
    if (recorded[key] !== undefined) delete gaps[key]
  }
  const prices = { ...defaults?.prices }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (recorded.prices?.[key] !== undefined) delete prices[key]
  }
  const mergedPrices = { ...prices, ...explicit?.prices }
  delete gaps.prices
  const facts = { ...gaps, ...explicit, ...(Object.keys(mergedPrices).length > 0 ? { prices: mergedPrices } : {}) }
  return Object.keys(facts).length > 0 ? facts : undefined
}
