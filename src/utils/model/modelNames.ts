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

function canonicalMatch(id: string): string {
  if (providerCapabilities().isCarrierShapedId(id)) return id
  const lowered = id.toLowerCase()
  const declared = DECLARED_CANONICALS.find(config => lowered.endsWith(config.firstParty))
  if (declared !== undefined) return declared.canonical ?? declared.firstParty
  const generation = parseFirstPartyGeneration(lowered)
  if (generation !== null) return DECLARED_GENERATION_STEMS.get(generation.stem) ?? generation.stem
  if (lowered.includes('3-7-sonnet')) return 'claude-3-7-sonnet'
  if (lowered.includes('3-5-sonnet')) return 'claude-3-5-sonnet'
  if (lowered.includes('3-5-haiku')) return 'claude-3-5-haiku'
  const generic = lowered.match(/(claude-[a-z0-9-]+)/)
  if (generic) return generic[1]
  return id
}

export function getCanonicalName(name: string): string {
  const normalized = normalizeModelStringForAPI(name)
  const internalResolved = resolveInternalModel(normalized) ?? normalized
  return canonicalMatch(resolveOverriddenModel(internalResolved))
}

export function firstPartyNameToCanonical(name: string): string {
  return canonicalMatch(normalizeModelStringForAPI(name))
}

export function isOpus1mMergeEnabled(): boolean {
  return false
}
