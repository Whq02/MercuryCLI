import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import {
  getEngineModelOverride,
} from '../../boot/process-state/processState.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { frontierOperatorDecision, newestPermittedGeneration } from './frontierPolicy.js'
import {
  CHOOSE_A_MODEL_ID,
  CHOOSE_A_MODEL_WORDS,
  computedDefault,
  describeComputedDefaultLabel,
  describeComputedDefaultRow,
  isChooseAModel,
} from './computedDefault.js'
import { context1mNeedsUnsentHeader, has1mContext } from '../facts/capabilities.js'
import { gptDisplayName } from '../facts/pins/gptPins.js'
import { isMistralModelId } from '../facts/pins/mistralPins.js'
import { getPinnedModelIds } from '../facts/pinnedModelIds.js'
import { recognizeModelId } from '../roads/idSpaces.js'
import { deepseekRetiredAliasTarget } from '../facts/pins/deepseekPins.js'
import { resolveBareFamilyWord } from './bareFamilyWords.js'
import { firstPartyString, getCanonicalName, getDefaultFableModel, getDefaultHaikuModel, getDefaultOpusModel, getDefaultSonnetModel, normalizeModelStringForAPI } from '../facts/modelNames.js'
import { tellHowAModelSettingResolves } from '../facts/settingResolution.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export { firstPartyNameToCanonical, getCanonicalName, getDefaultFableModel, getDefaultHaikuModel, getDefaultOpusModel, getDefaultSonnetModel, isOpus1mMergeEnabled, normalizeModelStringForAPI } from '../facts/modelNames.js'
export { isDefaultOpusNatively1M, newestPermittedFallback } from './frontierPolicy.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = string | null


const TRAILING_1M_RE = /\[1m\]$/i

function hasContext1mSuffix(model: string): boolean {
  return TRAILING_1M_RE.test(model.trim())
}


function rosterFamilyModel(family: Parameters<typeof newestPermittedGeneration>[0], head: string, pin: string | undefined): string {
  if (pin || getInitialSettings().engine?.roster === undefined) return head
  return newestPermittedGeneration(family, head) ?? head
}


export function isFableAvailable(): boolean {
  return frontierOperatorDecision().source === 'frontier'
}


export function getBestModel(): string {
  return parseUserSpecifiedModel(frontierOperatorDecision().setting)
}

export function getDefaultEngineModelSetting(): string {
  return computedDefault().setting
}

export function getDefaultEngineModel(): string {
  return parseUserSpecifiedModel(getDefaultEngineModelSetting())
}

function providerNameOf(): (family: string) => string {
  const { providerDisplayName } =
    require('../roads/routeLaw.js') as typeof import('../roads/routeLaw.js')
  return providerDisplayName
}


const RETIRED_LARGE_IDS: ReadonlySet<string> = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

export function parseUserSpecifiedModel(input: string): string {
  return parseUserSpecifiedModelCore(input, true)
}
tellHowAModelSettingResolves(parseUserSpecifiedModel)

export function parseUserSpecifiedModelRaw(input: string): string {
  return parseUserSpecifiedModelCore(input, false)
}

function parseUserSpecifiedModelCore(input: string, catalogueFold: boolean): string {
  const trimmed = input.trim()
  const hasSuffix = TRAILING_1M_RE.test(trimmed)
  const bare = trimmed.replace(TRAILING_1M_RE, '')
  const lowered = bare.toLowerCase()
  const reattach = (result: string): string =>
    hasSuffix && !TRAILING_1M_RE.test(result) ? `${result}[1m]` : result

  switch (lowered) {
    case 'sonnet':
      return reattach(rosterFamilyModel('sonnet', getDefaultSonnetModel(), flagEnv('MERCURY_DEFAULT_SONNET_MODEL')))
    case 'opus':
      return reattach(rosterFamilyModel('opus', getDefaultOpusModel(), flagEnv('MERCURY_DEFAULT_OPUS_MODEL')))
    case 'haiku':
      return reattach(rosterFamilyModel('haiku', getDefaultHaikuModel(), flagEnv('MERCURY_DEFAULT_HAIKU_MODEL')))
    case 'haiku55':
      return reattach(firstPartyString('haiku55'))
    case 'fable':
      return reattach(rosterFamilyModel('fable', getDefaultFableModel(), flagEnv('MERCURY_DEFAULT_FABLE_MODEL')))
    case 'fable51':
      return reattach(firstPartyString('fable51'))
    case 'fable52':
      return reattach(firstPartyString('fable52'))
    case 'mythos':
      return reattach(firstPartyString('mythos52'))
    case 'sonnet5':
      return reattach(firstPartyString('sonnet5'))
    case 'sonnet55':
      return reattach(firstPartyString('sonnet55'))
    case 'opus5':
      return reattach(firstPartyString('opus5'))
    case 'opus55':
      return reattach(firstPartyString('opus55'))
    case 'best':
      return getBestModel()
    default:
      break
  }

  if (isChooseAModel(lowered)) return CHOOSE_A_MODEL_ID

  const familyRow = resolveBareFamilyWord(lowered)
  if (familyRow !== undefined) {
    return reattach(familyRow)
  }

  if (RETIRED_LARGE_IDS.has(bare)) {
    return reattach(getDefaultOpusModel())
  }

  const deepseekCurrent = deepseekRetiredAliasTarget(lowered)
  if (deepseekCurrent !== undefined) {
    return reattach(deepseekCurrent)
  }

  if (catalogueFold && recognizeModelId(bare).kind === 'unrecognised') {
    try {
      const { resolveCatalogueSpelling } =
        require('./modelSpellingFold.js') as typeof import('./modelSpellingFold.js')
      const resolved = resolveCatalogueSpelling(bare)
      if (resolved !== null) return reattach(resolved)
    } catch (error) {
      passedOver(error)
    }
  }

  return reattach(bare)
}


export function getUserSpecifiedModelSetting(): ModelSetting {
  const override = getEngineModelOverride()
  let setting: ModelSetting
  if (override !== undefined) {
    setting = override
  } else {
    const envModel = flagEnv('MERCURY_MODEL')
    if (envModel) {
      setting = envModel
    } else {
      const saved = getInitialSettings().engine?.model
      setting = saved && saved !== '' ? saved : null
    }
  }
  if (setting === null) return null
  return setting
}

export function getEngineModel(): string {
  const setting = getUserSpecifiedModelSetting()
  const fromDefault = setting === null
  return fromDefault ? getDefaultEngineModel() : parseUserSpecifiedModel(setting)
}

export function isNonCustomOpusModel(model: string): boolean {
  return getCanonicalName(model).includes('opus')
}


const ONE_M_TWIN_KEYS = new Set(['fable5', 'fable51', 'fable52', 'mythos5', 'mythos51', 'mythos52', 'opus55', 'opus5', 'opus48', 'opus47', 'opus46', 'sonnet55', 'sonnet5', 'sonnet46', 'sonnet45', 'sonnet40', 'haiku55'])

const DISPLAY_NAMES: Record<string, string> = {
  fable5: 'Fable 5',
  fable51: 'Fable 5.1',
  fable52: 'Fable 5.2',
  mythos5: 'Mythos 5',
  mythos51: 'Mythos 5.1',
  mythos52: 'Mythos 5.2',
  opus55: 'Opus 5.5',
  opus5: 'Opus 5',
  opus48: 'Opus 4.8',
  opus47: 'Opus 4.7',
  opus46: 'Opus 4.6',
  opus45: 'Opus 4.5',
  opus41: 'Opus 4.1',
  opus40: 'Opus 4',
  sonnet55: 'Sonnet 5.5',
  sonnet5: 'Sonnet 5',
  sonnet46: 'Sonnet 4.6',
  sonnet45: 'Sonnet 4.5',
  sonnet40: 'Sonnet 4',
  sonnet37: 'Sonnet 3.7',
  sonnet35: 'Sonnet 3.5',
  haiku55: 'Haiku 5.5',
  haiku45: 'Haiku 4.5',
  haiku35: 'Haiku 3.5',
}

function resolvedStringToKey(): Map<string, string> {
  const strings = getPinnedModelIds()
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(strings)) map.set(value, key)
  return map
}

export function getPublicModelDisplayName(model: string): string | null {
  const bare = normalizeModelStringForAPI(model)
  if (isChooseAModel(bare)) return CHOOSE_A_MODEL_WORDS
  const hasSuffix = hasContext1mSuffix(model)
  const key = resolvedStringToKey().get(bare)
  if (key !== undefined) {
    const base = DISPLAY_NAMES[key]
    if (base !== undefined) {
      return hasSuffix && ONE_M_TWIN_KEYS.has(key) && !context1mNeedsUnsentHeader(model) ? `${base} (1M context)` : base
    }
  }
  if (/^grok-/i.test(bare)) {
    const { xaiDisplayPin } = require('../facts/pins/xaiPins.js') as typeof import('../facts/pins/xaiPins.js')
    return xaiDisplayPin(bare)?.displayName ?? null
  }
  if (/^muse-/i.test(bare)) {
    const { metaDisplayPin } = require('../facts/pins/metaPins.js') as typeof import('../facts/pins/metaPins.js')
    return metaDisplayPin(bare)?.displayName ?? null
  }
  if (isMistralModelId(bare)) {
    const { mistralDisplayPin } = require('../facts/pins/mistralPins.js') as typeof import('../facts/pins/mistralPins.js')
    return mistralDisplayPin(bare)?.displayName ?? null
  }
  if (/^minimax-/i.test(bare)) {
    const { minimaxDisplayPin } = require('../facts/pins/minimaxPins.js') as typeof import('../facts/pins/minimaxPins.js')
    return minimaxDisplayPin(bare)?.displayName ?? null
  }
  if (/^(?:command-|north-|c4ai-aya-)/i.test(bare)) {
    const { cohereDisplayPin } = require('../facts/pins/coherePins.js') as typeof import('../facts/pins/coherePins.js')
    return cohereDisplayPin(bare)?.displayName ?? null
  }
  if (/^(?:qwen|qwq|qvq)(?:[0-9.]|-)/i.test(bare)) {
    const { qwenDisplayPin } = require('../facts/pins/qwenPins.js') as typeof import('../facts/pins/qwenPins.js')
    return qwenDisplayPin(bare)?.displayName ?? null
  }
  if (/^together\//i.test(bare)) {
    const { togetherDisplayPin } = require('../facts/pins/togetherPins.js') as typeof import('../facts/pins/togetherPins.js')
    return togetherDisplayPin(bare)?.displayName ?? null
  }
  if (/^orcarouter\//i.test(bare)) {
    const { orcarouterListedModel } = require('../roads/orcarouter/orcarouterCatalogue.js') as typeof import('../roads/orcarouter/orcarouterCatalogue.js')
    return orcarouterListedModel(bare)?.displayName ?? null
  }
  if (/^groq\//i.test(bare)) {
    const { groqDisplayPin } = require('../facts/pins/groqPins.js') as typeof import('../facts/pins/groqPins.js')
    return groqDisplayPin(bare)?.displayName ?? null
  }
  if (/^cerebras\//i.test(bare)) {
    const { cerebrasDisplayPin } = require('../facts/pins/cerebrasPins.js') as typeof import('../facts/pins/cerebrasPins.js')
    return cerebrasDisplayPin(bare)?.displayName ?? null
  }
  if (/^fireworks\//i.test(bare)) {
    const { fireworksDisplayPin } = require('../facts/pins/fireworksPins.js') as typeof import('../facts/pins/fireworksPins.js')
    return fireworksDisplayPin(bare)?.displayName ?? null
  }
  const gpt = gptDisplayName(bare)
  if (gpt !== undefined) {
    return gpt
  }
  return null
}

export function renderModelName(model: string): string {
  return getPublicModelDisplayName(model) ?? model
}

export function renderModelChip(model: string): string {
  const base = getPublicModelDisplayName(normalizeModelStringForAPI(model))
  if (base === null) return model
  return hasContext1mSuffix(model) ? `${base} [1m]` : base
}

const CAPITALIZED_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'mythos', 'best'])

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

export function renderModelSetting(setting: string): string {
  const trimmed = setting.trim()
  const bare = trimmed.replace(TRAILING_1M_RE, '').toLowerCase()
  if (CAPITALIZED_ALIASES.has(bare)) {
    return capitalizeFirst(trimmed)
  }
  return renderModelName(setting)
}

export function renderDefaultModelSetting(setting: ModelSetting): string {
  if (setting === null) {
    return computedDefault().row
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getPublicModelName(model: string): string {
  const display = getPublicModelDisplayName(model)
  return display !== null ? `Claude ${display}` : `Claude (${model})`
}

export function renderDefaultModelLabel(): string {
  return describeComputedDefaultLabel(computedDefault(), providerNameOf())
}

export function modelDisplayString(setting: ModelSetting): string {
  if (setting === null) {
    return describeComputedDefaultRow(computedDefault(), providerNameOf())
  }
  const resolved = parseUserSpecifiedModel(setting)
  const rendered = renderModelName(resolved)
  return resolved === setting ? rendered : `${setting} (${rendered})`
}


const MARKETING_NAMES: Record<string, string> = {
  ...DISPLAY_NAMES,
  sonnet37: 'Claude 3.7 Sonnet',
  sonnet35: 'Claude 3.5 Sonnet',
  haiku35: 'Claude 3.5 Haiku',
}

export function getMarketingNameForModel(id: string): string | null {
  const bare = normalizeModelStringForAPI(id)
  const key = resolvedStringToKey().get(bare)
  if (key !== undefined) {
    const name = MARKETING_NAMES[key]
    if (name !== undefined) {
      return hasContext1mSuffix(id) && ONE_M_TWIN_KEYS.has(key) && !context1mNeedsUnsentHeader(id)
        ? `${name} (with 1M context)`
        : name
    }
  }
  return gptDisplayName(bare) ?? null
}


export function getDefaultModelDescription(): string {
  return describeComputedDefaultRow(computedDefault(), providerNameOf()).slice('Default '.length)
}

export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (!hasContext1mSuffix(currentModel) || hasContext1mSuffix(skillModel)) {
    return skillModel
  }
  const resolved = parseUserSpecifiedModel(skillModel)
  if (!has1mContext(resolved)) {
    return skillModel
  }
  return `${normalizeModelStringForAPI(skillModel)}[1m]`
}

