import { getModelStrings as getModelStringsSlot, setModelStrings } from '../../boot/process-state/processState.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type ModelConfig,
  type ModelKey,
} from './builtInModelTable.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export type PinnedModelIds = Record<ModelKey, string>


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

function applyOverrides(base: PinnedModelIds): PinnedModelIds {
  const overrides = readOverrides()
  const entries = Object.entries(overrides)
  if (entries.length === 0) return base
  const result: PinnedModelIds = { ...base }
  for (const [canonicalId, overrideId] of entries) {
    const key = CANONICAL_ID_TO_KEY[canonicalId]
    if (key !== undefined) {
      result[key] = overrideId
    }
  }
  return result
}

export function resolveOverriddenModel(id: string): string {
  const overrides = readOverrides()
  for (const [canonicalId, overrideId] of Object.entries(overrides)) {
    if (overrideId === id) return canonicalId
  }
  return id
}


function builtInStrings(): PinnedModelIds {
  const strings = {} as PinnedModelIds
  for (const [key, config] of Object.entries(ALL_MODEL_CONFIGS) as Array<[ModelKey, ModelConfig]>) {
    strings[key] = config.firstParty
  }
  return strings
}

export function getPinnedModelIds(): PinnedModelIds {
  let base = getModelStringsSlot()
  if (base === null) {
    base = builtInStrings()
    setModelStrings(base)
  }
  return applyOverrides(base)
}
