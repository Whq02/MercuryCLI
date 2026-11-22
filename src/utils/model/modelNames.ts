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
import { notBuilt } from '../../pi/holes.js'

const CONTEXT_SUFFIX_RE = /\[(?:[0-9]+m|served)\]/gi

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(CONTEXT_SUFFIX_RE, '')
}

export function firstPartyString(key: keyof typeof ALL_MODEL_CONFIGS): string {
  return getModelStrings()[key]
}

export function getDefaultOpusModel(): string {
  return notBuilt('src/utils/model/modelNames.ts:23')
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

export function getCanonicalName(name: string): string {
  return notBuilt('src/utils/model/modelNames.ts:65')
}

export function firstPartyNameToCanonical(name: string): string {
  return notBuilt('src/utils/model/modelNames.ts:71')
}

export function isOpus1mMergeEnabled(): boolean {
  return notBuilt('src/utils/model/modelNames.ts:75')
}
