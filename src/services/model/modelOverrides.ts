import { getInitialSettings } from '../../utils/settings/settings.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { getCanonicalName } from '../../utils/model/modelNames.js'
import { ALL_MODEL_CONFIGS, familyHeadOf } from '../../utils/model/configs.js'
import { bareModelIdOf, bareFamilyWordOfRoute } from './bareFamilyWords.js'
import type { OperatorModelFacts } from '../../utils/model/capabilityRegistry.js'
import { notBuilt } from '../../pi/holes.js'

export type { OperatorModelFacts }

export function modelHasRecordedFacts(model: string): boolean {
  return notBuilt('src/services/model/modelOverrides.ts:10')
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
