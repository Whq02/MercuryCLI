import {
  getInitialMainLoopModel,
  getMainLoopModelOverride,
} from '../../bootstrap/state.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { logForDebugging } from '../debug.js'
import { frontierOperatorDecision } from './frontierPolicy.js'
import {
  computedDefault,
  describeComputedDefaultLabel,
  describeComputedDefaultRow,
} from './computedDefault.js'
import { getContextWindowForModel, has1mContext } from './capabilities.js'
import { gptDisplayName } from '../../services/providers/openai/gptPins.js'
import { resolveAntModel } from './antModels.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { isCarrierShapedId, recognizeModelId } from '../../services/providers/idSpaces.js'
import { enforceSubagentModelFloor } from './modelFloor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = string | null


const CONTEXT_SUFFIX_RE = /\[(?:[0-9]+m|served)\]/gi
const TRAILING_1M_RE = /\[1m\]$/i

function hasContext1mSuffix(model: string): boolean {
  return TRAILING_1M_RE.test(model.trim())
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(CONTEXT_SUFFIX_RE, '')
}


function firstPartyString(key: keyof typeof ALL_MODEL_CONFIGS): string {
  return getModelStrings()[key]
}

export function getDefaultOpusModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  if (pin) return pin
  return firstPartyString('opus5')
}

export function getDefaultSonnetModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  if (pin) return pin
  return firstPartyString('sonnet5')
}

export function getDefaultHaikuModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  if (pin) return pin
  return firstPartyString('haiku45')
}

export function getDefaultFableModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (pin) return pin
  return firstPartyString('fable5')
}

export function isFableAvailable(): boolean {
  return frontierOperatorDecision().source === 'frontier'
}

export function getSmallFastModel(): string {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}


export function getBestModel(): string {
  return parseUserSpecifiedModel(frontierOperatorDecision().setting)
}

export function getDefaultMainLoopModelSetting(): string {
  return computedDefault().setting
}

export function getDefaultMainLoopModel(): string {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

function providerNameOf(): (family: string) => string {
  const { providerDisplayName } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  return providerDisplayName
}


const RETIRED_LARGE_IDS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

export function parseUserSpecifiedModel(input: string): string {
  return parseUserSpecifiedModelCore(input, true)
}

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
      return reattach(getDefaultSonnetModel())
    case 'opus':
      return reattach(getDefaultOpusModel())
    case 'haiku':
      return reattach(getDefaultHaikuModel())
    case 'fable':
      return reattach(getDefaultFableModel())
    case 'fable51':
      return reattach(firstPartyString('fable51'))
    case 'mythos':
      return reattach(firstPartyString('mythos5'))
    case 'sonnet5':
      return reattach(firstPartyString('sonnet5'))
    case 'opus5':
      return reattach(firstPartyString('opus5'))
    case 'opusplan':
      return reattach(getDefaultSonnetModel())
    case 'best':
      return getBestModel()
    default:
      break
  }

  if (RETIRED_LARGE_IDS.has(bare)) {
    return reattach(getDefaultOpusModel())
  }

  if (catalogueFold && recognizeModelId(bare).kind === 'unrecognised') {
    try {
      const { resolveCatalogueSpelling } =
        require('./modelSpellingFold.js') as typeof import('./modelSpellingFold.js')
      const resolved = resolveCatalogueSpelling(bare)
      if (resolved !== null) return reattach(resolved)
    } catch {
    }
  }

  return reattach(bare)
}


export function getUserSpecifiedModelSetting(): ModelSetting {
  const override = getMainLoopModelOverride()
  let setting: ModelSetting
  if (override !== undefined) {
    setting = override
  } else {
    const envModel = process.env.ANTHROPIC_MODEL
    if (envModel) {
      setting = envModel
    } else {
      const saved = getSettings_DEPRECATED().model
      setting = saved && saved !== '' ? saved : null
    }
  }
  if (setting === null) return null
  return setting
}

export function getMainLoopModel(): string {
  const setting = getUserSpecifiedModelSetting()
  const fromDefault = setting === null
  const resolved = fromDefault ? getDefaultMainLoopModel() : parseUserSpecifiedModel(setting)
  if (fromDefault && flagEnv('MERCURY_WORKER_PARENT_PID')) {
    return enforceSubagentModelFloor(resolved, 'daemon:worker-loop')
  }
  return resolved
}


export function getRuntimeMainLoopModel(params: {
  mainLoopModel: string
  permissionMode?: string
  exceeds200kTokens?: boolean
}): string {
  const { permissionMode } = params
  const setting = getUserSpecifiedModelSetting()
  const settingLower = (setting ?? '').trim().toLowerCase().replace(TRAILING_1M_RE, '')
  const isPlan = permissionMode === 'strategy'
  if (settingLower === 'opusplan' && isPlan && params.exceeds200kTokens !== true) {
    return getDefaultOpusModel()
  }
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'strategy') {
    return getDefaultSonnetModel()
  }
  return params.mainLoopModel
}

export function isNonCustomOpusModel(model: string): boolean {
  return getCanonicalName(model).includes('opus')
}


function canonicalMatch(id: string): string {
  if (isCarrierShapedId(id)) return id
  const lowered = id.toLowerCase()
  if (lowered.includes('sonnet-5')) return 'claude-sonnet-5'
  if (lowered.includes('opus-5')) return 'claude-opus-5'
  if (lowered.includes('fable-5-1') || lowered.includes('mythos-5-1')) return 'claude-fable-5-1'
  if (lowered.includes('fable-5') || lowered.includes('mythos-5')) return 'claude-fable-5'
  if (lowered.includes('opus-4-8') || lowered.includes('opus-4-7') || lowered.includes('opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (lowered.includes('opus-4-5')) return 'claude-opus-4-5'
  if (lowered.includes('opus-4-1')) return 'claude-opus-4-1'
  if (lowered.includes('opus-4')) return 'claude-opus-4'
  if (lowered.includes('sonnet-4-6')) return 'claude-sonnet-4-6'
  if (lowered.includes('sonnet-4-5')) return 'claude-sonnet-4-5'
  if (lowered.includes('sonnet-4')) return 'claude-sonnet-4'
  if (lowered.includes('haiku-4-5')) return 'claude-haiku-4-5'
  if (lowered.includes('3-7-sonnet')) return 'claude-3-7-sonnet'
  if (lowered.includes('3-5-sonnet')) return 'claude-3-5-sonnet'
  if (lowered.includes('3-5-haiku')) return 'claude-3-5-haiku'
  const generic = lowered.match(/(claude-[a-z0-9-]+)/)
  if (generic) return generic[1]
  return id
}

export function getCanonicalName(name: string): string {
  const normalized = normalizeModelStringForAPI(name)
  const antResolved = resolveAntModel(normalized) ?? normalized
  return canonicalMatch(resolveOverriddenModel(antResolved))
}

export function firstPartyNameToCanonical(name: string): string {
  return canonicalMatch(normalizeModelStringForAPI(name))
}


const ONE_M_TWIN_KEYS = new Set(['fable5', 'fable51', 'mythos5', 'opus5', 'opus48', 'opus47', 'opus46', 'sonnet5', 'sonnet46', 'sonnet45', 'sonnet40'])

const DISPLAY_NAMES: Record<string, string> = {
  fable5: 'Fable 5',
  fable51: 'Fable 5.1',
  mythos5: 'Mythos 5',
  opus5: 'Opus 5',
  opus48: 'Opus 4.8',
  opus47: 'Opus 4.7',
  opus46: 'Opus 4.6',
  opus45: 'Opus 4.5',
  opus41: 'Opus 4.1',
  opus40: 'Opus 4',
  sonnet5: 'Sonnet 5',
  sonnet46: 'Sonnet 4.6',
  sonnet45: 'Sonnet 4.5',
  sonnet40: 'Sonnet 4',
  sonnet37: 'Sonnet 3.7',
  sonnet35: 'Sonnet 3.5',
  haiku45: 'Haiku 4.5',
  haiku35: 'Haiku 3.5',
}

function resolvedStringToKey(): Map<string, string> {
  const strings = getModelStrings()
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(strings)) map.set(value, key)
  return map
}

export function getPublicModelDisplayName(model: string): string | null {
  const bare = normalizeModelStringForAPI(model)
  const hasSuffix = hasContext1mSuffix(model)
  const key = resolvedStringToKey().get(bare)
  if (key !== undefined) {
    const base = DISPLAY_NAMES[key]
    if (base !== undefined) {
      return hasSuffix && ONE_M_TWIN_KEYS.has(key) ? `${base} (1M context)` : base
    }
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
  const lowered = setting.trim().toLowerCase().replace(TRAILING_1M_RE, '')
  if (lowered === 'opusplan') return 'Opus in strategy mode, else Sonnet'
  if (CAPITALIZED_ALIASES.has(lowered)) return capitalizeFirst(setting.trim())
  return renderModelName(setting)
}

export function renderDefaultModelSetting(setting: ModelSetting): string {
  if (setting === null) {
    return computedDefault().row
  }
  const lowered = setting.trim().toLowerCase().replace(TRAILING_1M_RE, '')
  if (lowered === 'opusplan') {
    return `${renderModelName(getDefaultOpusModel())} in strategy mode, else ${renderModelName(getDefaultSonnetModel())}`
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
  if (resolved === setting) return renderModelName(setting)
  return `${setting} (${renderModelName(resolved)})`
}


const MARKETING_NAMES: Record<string, string> = {
  ...DISPLAY_NAMES,
  sonnet37: 'Claude 3.7 Sonnet',
  sonnet35: 'Claude 3.5 Sonnet',
  haiku35: 'Claude 3.5 Haiku',
}

export function getMarketingNameForModel(id: string): string | null {
  const bare = normalizeModelStringForAPI(id)
  const hasSuffix = id.toLowerCase().includes('[1m]')
  const key = resolvedStringToKey().get(bare)
  if (key !== undefined) {
    const base = MARKETING_NAMES[key]
    if (base !== undefined) {
      return hasSuffix && ONE_M_TWIN_KEYS.has(key) ? `${base} (with 1M context)` : base
    }
  }
  const gptName = gptDisplayName(bare)
  if (gptName !== undefined) {
    return gptName
  }
  return null
}


export function isDefaultOpusNatively1M(): boolean {
  return getContextWindowForModel(normalizeModelStringForAPI(getDefaultOpusModel())) >= 1_000_000
}

export function isOpus1mMergeEnabled(): boolean {
  return false
}

export function isLegacyModelRemapEnabled(): boolean {
  return true
}

export function getDefaultModelDescription(): string {
  return describeComputedDefaultRow(computedDefault(), providerNameOf()).slice('Default '.length)
}

export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  const currentHasSuffix = hasContext1mSuffix(currentModel)
  const skillHasSuffix = hasContext1mSuffix(skillModel)
  if (!currentHasSuffix || skillHasSuffix) return skillModel
  const resolved = parseUserSpecifiedModel(skillModel)
  return has1mContext(resolved) ? `${normalizeModelStringForAPI(skillModel)}[1m]` : skillModel
}
