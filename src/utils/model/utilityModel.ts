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
  effortPinned: true
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

function servingLocalHelper(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { helperModelId } = require('../../services/providers/local/tensorfoldHelper.js') as typeof import('../../services/providers/local/tensorfoldHelper.js')
    return helperModelId({ start: false })
  } catch {
    return undefined
  }
}

export function utilityCallFor(seatModel: string = getEngineModel(), reads: { named?: boolean } = {}): UtilityCall {
  const route = declaredRouteOf(seatModel)
  const model = route === 'local' && reads.named !== true ? (servingLocalHelper() ?? seatModel) : seatModel
  const view = effortVocabularyFor(model)
  const floor = view.kind === 'ladder' || view.kind === 'provider' ? lowestServedEffort(view.vocabulary) : undefined
  const thinkingConfig: ThinkingConfig = route === null || route === 'anthropic' ? { type: 'disabled' } : { type: 'adaptive' }
  return {
    model,
    ...(floor !== undefined ? { effortValue: floor as EffortValue } : {}),
    effortPinned: true,
    thinkingConfig,
  }
}
