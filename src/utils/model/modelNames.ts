import { flagEnv } from '../../substrate/flagRegistry.js'
import { resolveInternalModel } from './internalModels.js'
import {
  ALL_MODEL_CONFIGS,
  DECLARED_GENERATION_STEMS,
  newestGenerationKey,
  parseFirstPartyGeneration,
  type ModelConfig,
} from './configs.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { providerCapabilities } from './capabilityRegistry.js'

const CONTEXT_SUFFIX_RE = /\[(?:[0-9]+m|served)\]/gi

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(CONTEXT_SUFFIX_RE, '')
}

export function firstPartyString(key: keyof typeof ALL_MODEL_CONFIGS): string {
  return getModelStrings()[key]
}

export function getDefaultOpusModel(): string {
  const pin = flagEnv('MERCURY_DEFAULT_OPUS_MODEL')
  if (pin) return pin
  return firstPartyString(newestGenerationKey('opus'))
}

export function getDefaultSonnetModel(): string {
  const pin = flagEnv('MERCURY_DEFAULT_SONNET_MODEL')
  if (pin) return pin
  return firstPartyString(newestGenerationKey('sonnet'))
}

export function getDefaultHaikuModel(): string {
  const pin = flagEnv('MERCURY_DEFAULT_HAIKU_MODEL')
  if (pin) return pin
  return firstPartyString(newestGenerationKey('haiku'))
}

export function getDefaultFableModel(): string {
  const pin = flagEnv('MERCURY_DEFAULT_FABLE_MODEL')
  if (pin) return pin
  return firstPartyString(newestGenerationKey('fable'))
}

const DECLARED_CANONICALS = (Object.values(ALL_MODEL_CONFIGS) as ModelConfig[])
  .sort((a, b) => b.firstParty.length - a.firstParty.length)

function canonicalName(id: string): string {
  if (providerCapabilities().isCarrierShapedId(id)) return id
  const lower = id.toLowerCase()
  const config = DECLARED_CANONICALS.find(config => lower.endsWith(config.firstParty))
  if (config) return config.canonical ?? config.firstParty
  const generation = parseFirstPartyGeneration(lower)
  if (generation) return DECLARED_GENERATION_STEMS.get(generation.stem) ?? generation.stem
  for (const stem of ['3-7-sonnet', '3-5-sonnet', '3-5-haiku']) {
    if (lower.includes(stem)) return `claude-${stem}`
  }
  return lower.match(/claude-[a-z0-9-]+/)?.[0] ?? id
}

export function getCanonicalName(name: string): string {
  const model = normalizeModelStringForAPI(name)
  return canonicalName(resolveOverriddenModel(resolveInternalModel(model) ?? model))
}

export function firstPartyNameToCanonical(name: string): string {
  return canonicalName(normalizeModelStringForAPI(name))
}

export function isOpus1mMergeEnabled(): boolean {
  return false
}
