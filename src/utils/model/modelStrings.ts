import { getModelStrings as getModelStringsSlot, setModelStrings } from '../../bootstrap/state.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type ModelConfig,
  type ModelKey,
} from './configs.js'
import { passedOver } from '../passedOver.js'
import { notBuilt } from '../../pi/holes.js'

export type ModelStrings = Record<ModelKey, string>


function readOverrides(): Record<string, string> {
  try {
    const raw = getInitialSettings().engine?.pins
    if (!raw) return {}
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key in CANONICAL_ID_TO_KEY && typeof value === 'string' && value !== '') {
        filtered[key] = value
      }
    }
    return filtered
  } catch (error) {
    passedOver(error)
    return {}
  }
}

export function resolveOverriddenModel(id: string): string {
  return notBuilt('src/utils/model/modelStrings.ts:42')
}


function builtInStrings(): ModelStrings {
  const strings = {} as ModelStrings
  for (const [key, config] of Object.entries(ALL_MODEL_CONFIGS) as Array<[ModelKey, ModelConfig]>) {
    strings[key] = config.firstParty
  }
  return strings
}

export function getModelStrings(): ModelStrings {
  return notBuilt('src/utils/model/modelStrings.ts:59')
}
