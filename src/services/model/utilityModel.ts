import { WIRE_EFFORT_RANK } from '../../utils/model/pins/gptPins.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import type { EffortValue } from '../../utils/effort.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../utils/effortLadder.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { effortVocabularyFor } from '../../utils/model/capabilities.js'
import { getEngineModel } from './model.js'
import { passedOver } from '../../utils/passedOver.js'

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

export function floorEffort(vocabulary: readonly string[]): string | undefined {
  const ranked = vocabulary.filter(word => Number.isFinite(effortRank(word))).sort((a, b) => effortRank(a) - effortRank(b))
  const distance = (word: string): number => Math.abs(effortRank(word) - WIRE_EFFORT_RANK.low!)
  let floor: string | undefined
  for (const word of ranked) if (floor === undefined || distance(word) < distance(floor)) floor = word
  return floor ?? vocabulary[0]
}

function servingLocalHelper(): string | undefined {
  try {
    const { helperModelId } = require('../providers/local/tensorfoldHelper.js') as typeof import('../providers/local/tensorfoldHelper.js')
    return helperModelId()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function utilityCallFor(seatModel: string = getEngineModel(), reads: { named?: boolean } = {}): UtilityCall {
  const model = reads.named !== true ? (servingLocalHelper() ?? seatModel) : seatModel
  const route = declaredRouteOf(model)
  const view = effortVocabularyFor(model)
  const floor = view.kind === 'ladder' || view.kind === 'provider' ? floorEffort(view.vocabulary) : undefined
  const thinkingConfig: ThinkingConfig = route === null || route === 'anthropic' ? { type: 'disabled' } : { type: 'adaptive' }
  return {
    model,
    ...(floor !== undefined ? { effortValue: floor as EffortValue } : {}),
    effortPinned: true,
    thinkingConfig,
  }
}
