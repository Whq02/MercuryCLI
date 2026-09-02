/**
 * Resolved model-ID strings with settings overrides.
 *
 * Overrides (contract data setting `modelOverrides`, read from the
 * INITIAL-settings snapshot) are keyed by canonical first-party ID and layer
 * on EVERY read, including the pre-initialisation read, so a caller never
 * sees an unoverridden string.
 */
import { getModelStrings as getModelStringsSlot, setModelStrings } from '../../bootstrap/state.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type ModelConfig,
  type ModelKey,
} from './configs.js'

export type ModelStrings = Record<ModelKey, string>

// ---------------------------------------------------------------------------
// Settings overrides
// ---------------------------------------------------------------------------

/** The override map, keyed by canonical first-party ID; entries whose key is
 *  not a known canonical ID, or whose value is empty, are ignored. Safe to
 *  call during module init — a settings-read throw returns an empty map. */
function readOverrides(): Record<string, string> {
  try {
    const raw = (getInitialSettings() as { modelOverrides?: Record<string, string> })
      .modelOverrides
    if (!raw) return {}
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key in CANONICAL_ID_TO_KEY && typeof value === 'string' && value !== '') {
        filtered[key] = value
      }
    }
    return filtered
  } catch {
    return {}
  }
}

/** Apply overrides to a resolved strings map (keyed by table key). */
function applyOverrides(strings: ModelStrings): ModelStrings {
  const overrides = readOverrides()
  if (Object.keys(overrides).length === 0) return strings
  const result = { ...strings }
  for (const [canonicalId, replacement] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId]
    if (key !== undefined) result[key] = replacement
  }
  return result
}

/**
 * Map a settings-supplied replacement string back to its canonical
 * first-party ID (the input unchanged on no match). Safe during module init.
 */
export function resolveOverriddenModel(id: string): string {
  const overrides = readOverrides()
  for (const [canonicalId, replacement] of Object.entries(overrides)) {
    if (replacement === id) return canonicalId
  }
  return id
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function builtInStrings(): ModelStrings {
  const strings = {} as ModelStrings
  for (const [key, config] of Object.entries(ALL_MODEL_CONFIGS) as Array<[ModelKey, ModelConfig]>) {
    strings[key] = config.firstParty
  }
  return strings
}

/** The resolved strings, overrides layered on every read; set once. */
export function getModelStrings(): ModelStrings {
  const slot = getModelStringsSlot()
  if (slot !== null) return applyOverrides(slot as ModelStrings)
  const strings = builtInStrings()
  setModelStrings(strings)
  return applyOverrides(strings)
}
