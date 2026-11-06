import { WIRE_EFFORT_RANK } from '../../services/providers/openai/gptPins.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import type { EffortValue } from '../effort.js'
import { EFFORT_LEVELS, type EffortLevel } from '../effortLadder.js'
import type { ThinkingConfig } from '../thinking.js'
import { effortVocabularyFor } from './capabilities.js'
import { getEngineModel } from './model.js'

export interface UtilityCall {
  model: string
  effortValue?: EffortValue
  thinkingConfig: ThinkingConfig
}

function effortRank(word: string): number {
  const wire = WIRE_EFFORT_RANK[word]
  if (wire !== undefined) return wire
  const ladder = EFFORT_LEVELS.indexOf(word as EffortLevel)
  return ladder === -1 ? Number.POSITIVE_INFINITY : ladder + WIRE_EFFORT_RANK.low!
}

export function lowestServedEffort(vocabulary: readonly string[]): string | undefined {
  const ranked = vocabulary.filter(word => Number.isFinite(effortRank(word))).sort((a, b) => effortRank(a) - effortRank(b))
  return ranked[0] ?? vocabulary[0]
}

export function utilityCallFor(model: string = getEngineModel()): UtilityCall {
  const view = effortVocabularyFor(model)
  const floor = view.kind === 'ladder' || view.kind === 'provider' ? lowestServedEffort(view.vocabulary) : undefined
  const route = declaredRouteOf(model)
  const thinkingConfig: ThinkingConfig = route === null || route === 'anthropic' ? { type: 'disabled' } : { type: 'adaptive' }
  return {
    model,
    ...(floor !== undefined ? { effortValue: floor as EffortValue } : {}),
    thinkingConfig,
  }
}
