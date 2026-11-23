import memoize from 'lodash-es/memoize.js'
import { flagEnabled, flagEnv } from 'src/substrate/flagRegistry.js'
import { EFFORT_LEVELS, type EffortLevel } from '../effortLadder.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import {
  CODING_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
} from '../../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { isClaudeAISubscriber } from '../auth.js'
import { isEnvTruthy } from '../envUtils.js'
import { getCanonicalName } from './modelNames.js'
import { isChooseAModel } from './chooseAModel.js'
import { familyDefaultsModel, familyHeadOf } from './configs.js'
import { getModelCapability } from './modelCapabilities.js'
import type { CallModelRoute } from '../../types/providerRoute.js'
import { providerCapabilities, type OperatorModelFacts } from './capabilityRegistry.js'
import {
  gptDisplayPin,
  hasGptServedWindowSuffix,
  parseGptModelId,
} from './pins/gptPins.js'
import {
  glmDisplayPin,
  glmEffortsFor,
  glmTakesImages,
  isGlmModelId,
} from './pins/glmPins.js'
import {
  KIMI_EFFORT_STEPS,
  isKimiModelId,
  kimiDefaultEffort,
  kimiDisplayPin,
  kimiEffortsFor,
} from './pins/kimiPins.js'
import { isXaiModelId } from './pins/xaiPins.js'
import { isMetaModelId, metaDisplayPin } from './pins/metaPins.js'
import { isMistralModelId } from './pins/mistralPins.js'
import { isZenModelId, zenDisplayPin } from './pins/zenPins.js'
import { isMinimaxModelId, minimaxDisplayPin } from './pins/minimaxPins.js'
import { isTogetherModelId, togetherDisplayPin, togetherEffortVocabulary, togetherThinkingDial } from './pins/togetherPins.js'
import { isCohereModelId } from './pins/coherePins.js'
import { isGroqModelId, groqDisplayPin, groqEffortVocabulary } from './pins/groqPins.js'
import { isCerebrasModelId, cerebrasDisplayPin, cerebrasEffortVocabulary } from './pins/cerebrasPins.js'
import { isFireworksModelId, fireworksDisplayPin, fireworksEffortVocabulary } from './pins/fireworksPins.js'
import { isQwenModelId, qwenDefaultEffort, qwenDisplayPin, qwenEffortSteps } from './pins/qwenPins.js'
import {
  deepseekDisplayPin,
  DEEPSEEK_EFFORTS,
  isDeepseekModelId,
} from './pins/deepseekPins.js'
import { isHuggingfaceModelId } from './pins/huggingfacePins.js'
import { isFirstPartyAnthropicBaseUrl } from './providers.js'
import { tellWhatClearsTheBetas } from './betasClearing.js'

const isCarrierShapedId = (model: string): boolean => providerCapabilities()?.isCarrierShapedId(model) ?? false
const declaredRouteOf = (model: string): CallModelRoute | null => providerCapabilities()?.declaredRouteOf(model) ?? null
const modelHasRecordedFacts = (model: string): boolean => providerCapabilities().modelHasRecordedFacts(model)
const operatorModelFacts = (model: string, recorded?: OperatorModelFacts): OperatorModelFacts | undefined => providerCapabilities().operatorModelFacts(model, recorded)
const classifyModelRoute = (model: string) => providerCapabilities()?.classifyModelRoute(model) ?? ({ kind: 'unrecognised' } as const)
const qualifiedWireId = (model: string): string => providerCapabilities()?.qualifiedWireId(model) ?? model
const isMeliousModelId = (model: string): boolean => providerCapabilities()?.isMeliousModelId(model) ?? false
const isOrcarouterModelId = (model: string): boolean => providerCapabilities()?.isOrcarouterModelId(model) ?? false
const thinkingOffWireEffort = (vocabulary: readonly string[]): string | undefined => providerCapabilities()?.thinkingOffWireEffort(vocabulary)
const liveGptContextWindow = (model: string): number | undefined => providerCapabilities()?.liveGptContextWindow(model)
const liveGptContextCeiling = (model: string): number | undefined => providerCapabilities()?.liveGptContextCeiling(model)
const liveGptDefaultEffort = (canonicalId: string): string | undefined => providerCapabilities()?.liveGptDefaultEffort(canonicalId)
const liveGptEffortCatalogue = (canonicalId: string) => providerCapabilities()?.liveGptEffortCatalogue(canonicalId)
const xaiModelFacts = (model: string) => providerCapabilities()?.xaiModelFacts(model)
const mistralModelFacts = (model: string) => providerCapabilities()?.mistralModelFacts(model) ?? { efforts: [] as readonly string[] }
const cohereModelFacts = (model: string) => providerCapabilities()?.cohereModelFacts(model) ?? { efforts: [] as readonly string[] }
const qwenModelFacts = (model: string) => providerCapabilities()?.qwenModelFacts(model) ?? { efforts: [] as readonly string[] }
const togetherContextWindowFor = (id: string): number | undefined => providerCapabilities()?.togetherContextWindowFor(id)
const groqContextWindowFor = (id: string): number | undefined => providerCapabilities()?.groqContextWindowFor(id)
const groqOutputMaxFor = (model: string): number | undefined => providerCapabilities()?.groqOutputMaxFor(model)
const meliousListedModel = (model: string) => providerCapabilities()?.meliousListedModel(model)
const meliousEffortVocabulary = (model: string): readonly string[] => providerCapabilities()?.meliousEffortVocabulary(model) ?? []
const meliousContextWindowFor = (id: string): number | undefined => providerCapabilities()?.meliousContextWindowFor(id)
const meliousOutputMaxFor = (model: string): number | undefined => providerCapabilities()?.meliousOutputMaxFor(model)
const orcarouterListedModel = (model: string) => providerCapabilities()?.orcarouterListedModel(model)
const orcarouterEffortVocabulary = (model: string): readonly string[] => providerCapabilities()?.orcarouterEffortVocabulary(model) ?? []
const cerebrasContextWindowFor = (id: string): number | undefined => providerCapabilities()?.cerebrasContextWindowFor(id)
const cerebrasOutputMaxFor = (model: string): number | undefined => providerCapabilities()?.cerebrasOutputMaxFor(model)
const fireworksContextWindowFor = (id: string): number | undefined => providerCapabilities()?.fireworksContextWindowFor(id)
const fireworksOutputMaxFor = (model: string): number | undefined => providerCapabilities()?.fireworksOutputMaxFor(model)
const deepseekModelFacts = (normalizedId: string) => providerCapabilities()?.deepseekModelFacts(normalizedId)


export function modelSupportsTemperature(model: string): boolean {
  if (isXaiModelId(model)) return xaiModelFacts(model)?.temperature === true
  if (isMetaModelId(model)) return metaDisplayPin(model) !== undefined
  if (isMistralModelId(model)) return true
  if (isZenModelId(model)) return true
  if (isMinimaxModelId(model) || isTogetherModelId(model) || isCohereModelId(model) || isGroqModelId(model) || isMeliousModelId(model) || isCerebrasModelId(model) || isFireworksModelId(model) || isQwenModelId(model)) return true
  const m = /claude-([a-z]+)-(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec(model)
  if (!m) return true
  const family = m[1]!
  const major = parseInt(m[2]!, 10)
  const minor = m[3] !== undefined ? parseInt(m[3], 10) : 0
  if (major >= 5) return false
  if (family === 'opus' && major === 4 && minor >= 7) return false
  return true
}


export function modelSupportsISP(model: string): boolean {
  if (isOrcarouterModelId(model)) return false
  if (isXaiModelId(model)) return modelSupportsThinking(model)
  if (isMetaModelId(model)) return false
  if (isMistralModelId(model)) return false
  if (isMinimaxModelId(model) || isTogetherModelId(model) || isCohereModelId(model) || isGroqModelId(model) || isMeliousModelId(model) || isCerebrasModelId(model) || isFireworksModelId(model) || isQwenModelId(model)) return false
  return !getCanonicalName(model).includes('claude-3-')
}

function baseModelSupportsThinking(model: string): boolean {
  if (isOrcarouterModelId(model)) return true
  if (isXaiModelId(model)) {
    const facts = xaiModelFacts(model)
    return facts?.reasoning ?? (facts?.efforts?.some(effort => effort !== 'none') === true)
  }
  if (isMetaModelId(model)) return metaDisplayPin(model) !== undefined
  if (isMistralModelId(model)) return mistralModelFacts(model).reasoning === true
  if (isZenModelId(model)) return true
  if (isMinimaxModelId(model)) return true
  if (isTogetherModelId(model)) return togetherThinkingDial(model) !== 'none'
  if (isCohereModelId(model)) return cohereModelFacts(model).reasoning === true
  if (isGroqModelId(model)) return ['included', 'parsed'].includes(groqDisplayPin(model)?.reasoning ?? '')
  if (isMeliousModelId(model)) return meliousListedModel(model)?.reasoning === true || ['reasoning', 'hybrid'].includes(meliousListedModel(model)?.reasoningType ?? '')
  if (isCerebrasModelId(model)) return ['included', 'parsed'].includes(cerebrasDisplayPin(model)?.reasoning ?? '')
  if (isFireworksModelId(model)) return ['included', 'parsed'].includes(fireworksDisplayPin(model)?.reasoning ?? '')
  if (isQwenModelId(model)) return qwenModelFacts(model).thinking === 'hybrid'
  return !getCanonicalName(model).includes('claude-3-')
}

export function modelSupportsAdaptiveThinking(model: string): boolean {
  if (
    isOrcarouterModelId(model) ||
    isXaiModelId(model) ||
    isMetaModelId(model) ||
    isMistralModelId(model) ||
    isMinimaxModelId(model) ||
    isTogetherModelId(model) ||
    isCohereModelId(model) ||
    isGroqModelId(model) ||
    isMeliousModelId(model) ||
    isCerebrasModelId(model) ||
    isFireworksModelId(model) ||
    isQwenModelId(model)
  ) {
    return false
  }
  const canonical = getCanonicalName(familyDefaultsModel(model))
  if (
    canonical === 'claude-haiku-5-5' ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('fable-5') ||
    canonical.includes('mythos-5') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('sonnet-4-6')
  ) {
    return true
  }
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  return true
}

export function modelThinkingAlwaysOn(model: string): boolean {
  if (isXaiModelId(model)) {
    return modelSupportsThinking(model) && !(xaiModelFacts(model)?.efforts?.includes('none') ?? false)
  }
  if (isMetaModelId(model)) return metaDisplayPin(model) !== undefined
  if (isMistralModelId(model)) return false
  if (isGroqModelId(model)) {
    const pin = groqDisplayPin(model)
    return pin !== undefined && pin.reasoning !== 'none' && !pin.efforts.includes('none')
  }
  if (isCerebrasModelId(model)) {
    const pin = cerebrasDisplayPin(model)
    return pin !== undefined && pin.reasoning !== 'none' && !pin.efforts.includes('none')
  }
  if (isFireworksModelId(model)) {
    const pin = fireworksDisplayPin(model)
    return pin !== undefined && pin.reasoning !== 'none' && !pin.efforts.includes('none')
  }
  if (isMeliousModelId(model)) return meliousListedModel(model)?.reasoningType === 'reasoning'
  if (isZenModelId(model)) {
    const pin = zenDisplayPin(model)
    return pin !== undefined && pin.thinkingToggle !== true && !(pin.efforts?.includes('none') ?? false)
  }
  if (isMinimaxModelId(model)) return minimaxDisplayPin(model)?.thinking !== 'toggle'
  if (isQwenModelId(model)) return false
  if (isTogetherModelId(model)) return togetherThinkingDial(model) === 'effort'
  if (isCohereModelId(model)) return false
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(familyDefaultsModel(model))
  return (
    canonical.includes('fable-5') ||
    canonical.includes('mythos-5') ||
    canonical === 'claude-opus-5-5' ||
    canonical === 'claude-sonnet-5-5'
  )
}

export function modelThinkingOffIsBetweenTools(model: string, outputConfig: { effort?: string | null; format?: unknown }): boolean {
  if (isCarrierShapedId(model) || getCanonicalName(model) !== 'claude-sonnet-5-5') return false
  if (outputConfig.format !== undefined && outputConfig.format !== null) return false
  const { effort } = outputConfig
  return effort === undefined || effort === null || effort === 'low' || effort === 'medium' || effort === 'high'
}

export function modelNarratesInThinkingBlocks(model: string): boolean {
  if (isCarrierShapedId(model)) return false
  const firstParty = familyDefaultsModel(model).toLowerCase()
  const canonical = getCanonicalName(firstParty)
  if (canonical === 'claude-fable-5') return !firstParty.includes('mythos')
  return canonical === 'claude-opus-5-5' || canonical === 'claude-sonnet-5-5' || canonical === 'claude-fable-5-2' || canonical === 'claude-fable-5-1'
}

export function modelSupportsForcedToolChoice(model: string): boolean {
  if (isCarrierShapedId(model)) return true
  const canonical = getCanonicalName(familyDefaultsModel(model))
  return canonical !== 'claude-fable-5-2' && canonical !== 'claude-fable-5-1' && canonical !== 'claude-opus-5-5' && canonical !== 'claude-sonnet-5-5'
}

export function modelSupportsMessageEffort(model: string): boolean {
  if (!isFirstPartyAnthropicBaseUrl()) return false
  const canonical = getCanonicalName(familyDefaultsModel(model))
  return canonical === 'claude-fable-5-2' || canonical === 'claude-fable-5-1' || canonical === 'claude-opus-5-5' || canonical === 'claude-opus-5' || canonical === 'claude-sonnet-5-5' || canonical === 'claude-haiku-5-5'
}

export function foldToolChoiceForModel<T extends { type: string }>(
  model: string,
  toolChoice: T | undefined,
): T | { type: 'auto' } | undefined {
  if (toolChoice === undefined) return undefined
  if (toolChoice.type !== 'any' && toolChoice.type !== 'tool') return toolChoice
  if (modelSupportsForcedToolChoice(model)) return toolChoice
  return { type: 'auto' }
}


export function modelSupportsStructuredOutputs(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  const canonical = getCanonicalName(familyDefaultsModel(model))
  return (
    canonical === 'claude-haiku-5-5' ||
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-fable-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-haiku-4-5')
  )
}


type GptEffortVocabularyView =
  | { state: 'not-gpt' }
  | { state: 'live'; vocabulary: readonly string[]; defaultEffort?: string; wordsFromRow?: true }
  | { state: 'known-empty'; defaultEffort?: string }
  | { state: 'unstated'; defaultEffort?: string }
  | { state: 'unavailable' }

export function gptEffortVocabularyView(model: string): GptEffortVocabularyView {
  const identity = parseGptModelId(model)
  if (!identity) return { state: 'not-gpt' }
  const catalogue = liveGptEffortCatalogue(identity.canonicalId)
  if (!catalogue) return { state: 'unavailable' }
  if (catalogue.vocabulary.length > 0) {
    return {
      state: 'live',
      vocabulary: catalogue.vocabulary,
      ...(catalogue.defaultEffort ? { defaultEffort: catalogue.defaultEffort } : {}),
      ...(catalogue.wordsFromRow === true ? { wordsFromRow: true as const } : {}),
    }
  }
  if (catalogue.stated) {
    return {
      state: 'known-empty',
      ...(catalogue.defaultEffort ? { defaultEffort: catalogue.defaultEffort } : {}),
    }
  }
  return {
    state: 'unstated',
    ...(catalogue.defaultEffort ? { defaultEffort: catalogue.defaultEffort } : {}),
  }
}

type EffortVocabularyView =
  | { kind: 'ladder'; source: 'first-party' | 'unknown-id'; vocabulary: readonly EffortLevel[] }
  | {
      kind: 'provider'
      source: 'operator' | 'gpt-live' | 'glm' | 'kimi' | 'deepseek' | 'xai' | 'meta' | 'gemini' | 'openrouter' | 'local' | 'mistral' | 'nous' | 'zen' | 'minimax' | 'together' | 'cohere' | 'groq' | 'orcarouter' | 'melious' | 'cerebras' | 'fireworks' | 'qwen' | 'compat'
      vocabulary: readonly string[]
      defaultEffort?: string
      thinkingGated: boolean
      thinkingOffWire?: string
      steps?: Readonly<Record<string, string>>
    }
  | { kind: 'offered'; source: 'gpt-unstated' | 'gpt-unavailable'; defaultEffort?: string }
  | {
      kind: 'none'
      source:
        | 'gpt-known-empty'
        | 'glm'
        | 'kimi'
        | 'xai'
        | 'meta'
        | 'mistral'
        | 'huggingface'
        | 'openrouter'
        | 'gemini'
        | 'compat'
        | 'local'
        | 'zen'
        | 'carrier'
        | 'first-party-legacy'
        | 'nous'
        | 'minimax'
        | 'together'
        | 'cohere'
        | 'groq'
        | 'melious'
        | 'orcarouter'
        | 'cerebras'
        | 'fireworks'
        | 'qwen'
        | 'choose-a-model'
      defaultEffort?: string
    }

const FIRST_PARTY_FULL_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const FIRST_PARTY_LADDER_TO_MAX: readonly EffortLevel[] = ['low', 'medium', 'high', 'max']
const UNKNOWN_ID_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high']

function baseEffortVocabularyFor(model: string): EffortVocabularyView {
  if (isChooseAModel(model)) return { kind: 'none', source: 'choose-a-model' }
  const gpt = gptEffortVocabularyView(model)
  switch (gpt.state) {
    case 'live':
      return {
        kind: 'provider',
        source: 'gpt-live',
        vocabulary: gpt.vocabulary,
        ...(gpt.defaultEffort !== undefined ? { defaultEffort: gpt.defaultEffort } : {}),
        thinkingGated: false,
      }
    case 'known-empty':
      return {
        kind: 'none',
        source: 'gpt-known-empty',
        ...(gpt.defaultEffort !== undefined ? { defaultEffort: gpt.defaultEffort } : {}),
      }
    case 'unstated':
      return {
        kind: 'offered',
        source: 'gpt-unstated',
        ...(gpt.defaultEffort !== undefined ? { defaultEffort: gpt.defaultEffort } : {}),
      }
    case 'unavailable':
      return { kind: 'offered', source: 'gpt-unavailable' }
    case 'not-gpt':
      break
  }
  if (isGlmModelId(model)) {
    const vocabulary = glmEffortsFor(model)
    return vocabulary
      ? { kind: 'provider', source: 'glm', vocabulary: [...vocabulary], thinkingGated: false }
      : { kind: 'none', source: 'glm' }
  }
  const route = declaredRouteOf(model)
  if (isKimiModelId(model) || route === 'moonshot') {
    const vocabulary = kimiEffortsFor(model)
    const defaultEffort = kimiDefaultEffort(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'kimi', vocabulary: [...vocabulary], ...(defaultEffort !== undefined ? { defaultEffort } : {}), thinkingGated: false, steps: KIMI_EFFORT_STEPS }
      : { kind: 'none', source: 'kimi' }
  }
  if (isDeepseekModelId(model) || route === 'deepseek') {
    return { kind: 'provider', source: 'deepseek', vocabulary: [...DEEPSEEK_EFFORTS], thinkingGated: true }
  }
  if (isXaiModelId(model) || route === 'xai') {
    const facts = xaiModelFacts(model)
    const vocabulary = facts?.efforts ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'xai', vocabulary, defaultEffort: facts?.defaultEffort, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'xai' }
  }
  if (isMetaModelId(model) || route === 'meta') {
    const vocabulary = metaDisplayPin(model)?.efforts ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'meta', vocabulary, thinkingGated: false }
      : { kind: 'none', source: 'meta' }
  }
  if (isMistralModelId(model) || route === 'mistral') {
    const vocabulary = mistralModelFacts(model).efforts
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'mistral', vocabulary, defaultEffort: 'high', thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'mistral' }
  }
  if (isHuggingfaceModelId(model)) return { kind: 'none', source: 'huggingface' }
  if (route === 'zen') {
    const pin = zenDisplayPin(model)
    const vocabulary = pin?.efforts ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'zen', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'zen' }
  }
  if (isMinimaxModelId(model) || route === 'minimax') {
    const vocabulary = minimaxDisplayPin(model)?.efforts ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'minimax', vocabulary, defaultEffort: 'max', thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'minimax' }
  }
  if (route === 'together') {
    const vocabulary = togetherEffortVocabulary(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'together', vocabulary, thinkingGated: true, thinkingOffWire: togetherThinkingDial(model) === 'effort' ? thinkingOffWireEffort(vocabulary) : undefined }
      : { kind: 'none', source: 'together' }
  }
  if (isCohereModelId(model) || route === 'cohere') {
    const vocabulary = cohereModelFacts(model).efforts
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'cohere', vocabulary, defaultEffort: 'high', thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'cohere' }
  }
  if (route === 'orcarouter') return { kind: 'provider', source: 'orcarouter', vocabulary: orcarouterEffortVocabulary(model), thinkingGated: false }
  if (route === 'groq') {
    const vocabulary = groqEffortVocabulary(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'groq', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'groq' }
  }
  if (route === 'melious') {
    const vocabulary = meliousEffortVocabulary(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'melious', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'melious' }
  }
  if (route === 'cerebras') {
    const vocabulary = cerebrasEffortVocabulary(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'cerebras', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'cerebras' }
  }
  if (route === 'fireworks') {
    const vocabulary = fireworksEffortVocabulary(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'fireworks', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'fireworks' }
  }
  if (isQwenModelId(model) || route === 'qwen') {
    const vocabulary = qwenModelFacts(model).efforts
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'qwen', vocabulary, defaultEffort: qwenDefaultEffort(model), thinkingGated: true, steps: qwenEffortSteps(model) }
      : { kind: 'none', source: 'qwen' }
  }
  if (route === 'openrouter') {
    const vocabulary = providerCapabilities()?.openrouterEffortVocabularyFor(model) ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'openrouter', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'openrouter' }
  }
  if (route === 'nous') {
    const vocabulary = providerCapabilities()?.nousEffortVocabularyFor(model) ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'nous', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'nous' }
  }
  if (route === 'gemini') {
    const vocabulary = providerCapabilities()?.geminiEffortVocabularyFor(model) ?? []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'gemini', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'gemini' }
  }
  if (route === 'openai-compat') {
    const compat = providerCapabilities()?.compatEffortFor(model)
    const vocabulary = compat?.vocabulary ?? []
    const thinkingOffWire = compat?.thinkingOffWire
    return vocabulary.length > 0 ? { kind: 'provider', source: 'compat', vocabulary, thinkingGated: thinkingOffWire !== undefined, ...(thinkingOffWire !== undefined ? { thinkingOffWire } : {}) } : { kind: 'none', source: 'compat' }
  }
  if (model.trim().toLowerCase().startsWith('local/')) {
    return providerCapabilities()?.localEffortFor(model) ?? { kind: 'none', source: 'local' }
  }
  if (isCarrierShapedId(model)) return { kind: 'none', source: 'carrier' }
  const m = familyDefaultsModel(model).toLowerCase()
  if (
    getCanonicalName(m) === 'claude-haiku-5-5' ||
    m.includes('sonnet-5') ||
    m.includes('opus-5') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('fable') ||
    m.includes('mythos')
  ) {
    return { kind: 'ladder', source: 'first-party', vocabulary: FIRST_PARTY_FULL_LADDER }
  }
  if (m.includes('opus-4-5') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return { kind: 'ladder', source: 'first-party', vocabulary: FIRST_PARTY_LADDER_TO_MAX }
  }
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return { kind: 'none', source: 'first-party-legacy' }
  }
  return { kind: 'ladder', source: 'unknown-id', vocabulary: UNKNOWN_ID_LADDER }
}

function vocabularyOffers(view: EffortVocabularyView, level: EffortLevel): boolean {
  switch (view.kind) {
    case 'none':
      return false
    case 'offered':
      return true
    case 'ladder':
    case 'provider':
      return (view.vocabulary as readonly string[]).includes(level)
  }
}

export function gptModelDefaultEffort(model: string): EffortLevel | undefined {
  const live = gptModelDefaultEffortRaw(model)
  return live !== undefined && (EFFORT_LEVELS as readonly string[]).includes(live) ? (live as EffortLevel) : undefined
}

function gptModelDefaultEffortRaw(model: string): string | undefined {
  const identity = parseGptModelId(model)
  if (!identity) return undefined
  return liveGptDefaultEffort(identity.canonicalId)
}

export function modelSupportsEffort(model: string): boolean {
  return effortVocabularyFor(model).kind !== 'none'
}

export function modelOffersEffortLevel(model: string, level: EffortLevel): boolean {
  return vocabularyOffers(effortVocabularyFor(model), level)
}

export function modelSupportsMaxEffort(model: string): boolean {
  return modelOffersEffortLevel(model, 'max')
}

export function modelSupportsXHighEffort(model: string): boolean {
  return modelOffersEffortLevel(model, 'xhigh')
}

export function getMaxSupportedEffortLevel(model: string): EffortLevel {
  const view = effortVocabularyFor(model)
  const aboveHigh = EFFORT_LEVELS.slice(EFFORT_LEVELS.indexOf('high') + 1).reverse()
  return aboveHigh.find(level => vocabularyOffers(view, level)) ?? 'high'
}


export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000
const STATED_OUTPUT_DEFAULT_CEILING = 128_000

function statedOutputTokens(upperLimit: number): { default: number; upperLimit: number } {
  return { default: Math.min(upperLimit, STATED_OUTPUT_DEFAULT_CEILING), upperLimit }
}

export function is1mContextDisabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_DISABLE_1M_CONTEXT'))
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

function modelIsNatively1M(model: string): boolean {
  if (isCarrierShapedId(model)) return false
  const family = familyDefaultsModel(model).toLowerCase()
  const canonical = getCanonicalName(family)
  return (
    canonical === 'claude-haiku-5-5' ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('fable-5') ||
    family.includes('opus-4-7') ||
    family.includes('opus-4-8')
  )
}

function modelNeeds1MHeader(model: string): boolean {
  const canonical = getCanonicalName(familyDefaultsModel(model))
  return canonical === 'claude-sonnet-4-5' || canonical === 'claude-sonnet-4'
}

export function context1mNeedsUnsentHeader(model: string): boolean {
  return modelNeeds1MHeader(model.replace(/\[1m\]/i, ''))
}

export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(familyDefaultsModel(model))
  return (
    canonical === 'claude-haiku-5-5' ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('fable-5')
  )
}


type ContextRequestedMode = 'default' | 'maximum'

type ContextActivation =
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }

export interface ContextResolution {
  model: string
  catalogueCurrent?: number
  catalogueMaximum?: number
  staticDefault?: number
  requestedMode: ContextRequestedMode
  activation: ContextActivation
  effectiveWindow: number
  source:
    | 'operator'
    | 'suffix-1m'
    | 'live-current'
    | 'static-pin'
    | 'capability'
    | 'beta-header'
    | 'fallback'
  pinAwaitingLive?: boolean
  outputReserve: number
  fallbackReason?: string
}

function normalizeForEnginePins(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]/g, '')
}

function baseResolveContextWindow(
  model: string,
  betas?: string[],
  requestedMode: ContextRequestedMode = 'default',
): ContextResolution {
  const finish = (
    r: Omit<ContextResolution, 'model' | 'requestedMode' | 'activation' | 'outputReserve'> & {
      activation?: ContextActivation
      fallbackReason?: string
    },
  ): ContextResolution => {
    let activation: ContextActivation = r.activation ?? { kind: 'none' }
    let fallbackReason = r.fallbackReason
    if (requestedMode === 'maximum' && activation.kind === 'none') {
      activation = {
        kind: 'unavailable',
        reason:
          'no provider-verified activation path — the CX-09/CX-13 provider-contract capture must land first',
      }
      fallbackReason = fallbackReason ?? 'maximum requested; no verified activation path'
    }
    return {
      model,
      requestedMode,
      activation,
      outputReserve: getModelMaxOutputTokens(model).default,
      ...r,
      fallbackReason,
    }
  }

  if (has1mContext(model)) {
    if (isCarrierShapedId(model) || isXaiModelId(model) || isMetaModelId(model) || isMistralModelId(model) || isMinimaxModelId(model) || isCohereModelId(model) || isQwenModelId(model)) {
      const base = resolveContextWindow(model.replace(/\[1m\]/i, ''), betas, requestedMode)
      return {
        ...base,
        model,
        activation: {
          kind: 'unavailable',
          reason: isXaiModelId(model) ? '[1m] is not a provider-verified activation path for xAI models' : isMetaModelId(model) ? '[1m] is not a provider-verified activation path for Meta models' : isMistralModelId(model) ? '[1m] is not a provider-verified activation path for Mistral models' : '[1m] is not a provider-verified activation path on a carrier-shaped id',
        },
        fallbackReason: 'unverified [1m] suffix ignored; resolved as the base id',
      }
    }
    const unsuffixed = model.replace(/\[1m\]/i, '')
    if (modelSupports1M(unsuffixed) && !context1mNeedsUnsentHeader(unsuffixed)) {
      return finish({ effectiveWindow: 1_000_000, source: 'suffix-1m' })
    }
    const base = resolveContextWindow(unsuffixed, betas, requestedMode)
    return {
      ...base,
      model,
      activation: {
        kind: 'unavailable',
        reason: parseGptModelId(unsuffixed) ? '[1m] is not a provider-verified activation path for GPT engine ids (CX-14)' : '[1m] is not a provider-verified activation path for this model',
      },
      fallbackReason: 'unverified [1m] suffix ignored; resolved as the base id',
    }
  }

  const carrierRoute = declaredRouteOf(model)
  if (carrierRoute === 'openrouter' || carrierRoute === 'gemini' || carrierRoute === 'nous') {
    const stated = providerCapabilities()?.carrierContextWindowFor(carrierRoute, normalizeForEnginePins(model))
    if (stated) {
      if (stated.window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
        return finish({
          effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
          source: stated.source,
          staticDefault: stated.window,
          fallbackReason: 'clamped by the 1M kill-switch',
        })
      }
      return finish({ effectiveWindow: stated.window, source: stated.source, staticDefault: stated.window })
    }
    return finish({
      effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
      source: 'fallback',
      fallbackReason: `the ${carrierRoute === 'openrouter' ? 'OpenRouter' : carrierRoute === 'nous' ? 'Nous Portal' : 'Gemini'} catalogue states no context length for this model (or is not fetched yet) — conservative default`,
    })
  }

  if (modelIsNatively1M(model)) {
    if (is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'static-pin',
        staticDefault: 1_000_000,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: 1_000_000,
      source: 'static-pin',
      staticDefault: 1_000_000,
    })
  }

  const gptServedChoice = hasGptServedWindowSuffix(model)
  const gptLive = liveGptContextWindow(model)
  const gptPin = gptDisplayPin(model)
  if (gptLive && gptLive >= 16_000) {
    const gptCeiling = liveGptContextCeiling(model)
    const gptWindow =
      !gptServedChoice && gptCeiling !== undefined && gptCeiling > gptLive ? gptCeiling : gptLive
    const shared = {
      catalogueCurrent: gptLive,
      catalogueMaximum: gptCeiling,
      ...(gptPin?.contextWindow !== undefined ? { staticDefault: gptPin.contextWindow } : {}),
    }
    if (gptWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'live-current',
        ...shared,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({ effectiveWindow: gptWindow, source: 'live-current', ...shared })
  }
  if (gptPin?.contextWindow !== undefined) {
    if (gptPin.contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'static-pin',
        staticDefault: gptPin.contextWindow,
        pinAwaitingLive: true,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: gptPin.contextWindow,
      source: 'static-pin',
      staticDefault: gptPin.contextWindow,
      pinAwaitingLive: true,
    })
  }

  if (isHuggingfaceModelId(model)) {
    const stated = providerCapabilities()?.huggingfaceContextWindowFor(normalizeForEnginePins(model))
    if (stated) {
      const pinned = stated.source === 'static-pin' ? { pinAwaitingLive: true } : {}
      if (stated.window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
        return finish({
          effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
          source: stated.source,
          staticDefault: stated.window,
          ...pinned,
          fallbackReason: 'clamped by the 1M kill-switch',
        })
      }
      return finish({ effectiveWindow: stated.window, source: stated.source, staticDefault: stated.window, ...pinned })
    }
  }

  if (model.trim().toLowerCase().startsWith('local/')) {
    const localWindow = providerCapabilities()?.localContextWindowFor(normalizeForEnginePins(model))
    if (localWindow?.kind === 'planned') {
      const window = localWindow.tokens
      const note = `local server context: ${localWindow.sourceWords}`
      if (window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
        return finish({
          effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
          source: 'live-current',
          staticDefault: window,
          fallbackReason: 'clamped by the 1M kill-switch',
        })
      }
      return finish({
        effectiveWindow: window,
        source: 'live-current',
        staticDefault: window,
        ...(localWindow.source === 'served' ? {} : { fallbackReason: note }),
      })
    }
    return finish({
      effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
      source: 'fallback',
      fallbackReason: localWindow?.unloadedWords !== undefined
        ? `local server context: ${localWindow.unloadedWords} — conservative default until then`
        : 'local model not discovered yet — conservative default until a probe answers',
    })
  }

  if (carrierRoute === 'deepseek') {
    const window = providerCapabilities()?.deepseekLiveContextWindow(normalizeForEnginePins(model))
    if (window !== undefined) return finish({ effectiveWindow: is1mContextDisabled() ? Math.min(window, MODEL_CONTEXT_WINDOW_DEFAULT) : window, source: 'live-current', catalogueCurrent: window })
  }
  if (isXaiModelId(model)) {
    const window = providerCapabilities()?.xaiLiveContextWindow(normalizeForEnginePins(model))
    if (window !== undefined) {
      return finish({ effectiveWindow: is1mContextDisabled() ? Math.min(window, MODEL_CONTEXT_WINDOW_DEFAULT) : window, source: 'live-current', catalogueCurrent: window })
    }
  }
  if (carrierRoute === 'orcarouter') {
    const window = orcarouterListedModel(model)?.contextWindow
    if (window !== undefined) return finish({ effectiveWindow: window, source: 'live-current', catalogueCurrent: window })
  }
  if (carrierRoute === 'openai-compat') {
    const window = providerCapabilities()?.compatContextWindowFor(model)
    if (window !== undefined) return finish({ effectiveWindow: window, source: 'live-current', catalogueCurrent: window })
  }
  const enginePinnedWindow = (() => {
    const id = normalizeForEnginePins(model)
    if (isGlmModelId(id)) return glmDisplayPin(id)?.contextWindow
    if (isKimiModelId(id) || carrierRoute === 'moonshot') return kimiDisplayPin(id)?.contextWindow
    if (isDeepseekModelId(id)) return deepseekDisplayPin(id)?.contextWindow
    if (isXaiModelId(id)) return xaiModelFacts(id)?.contextWindow
    if (isMetaModelId(id)) return metaDisplayPin(id)?.contextWindow
    if (isMistralModelId(id)) return mistralModelFacts(id).contextWindow
    if (isZenModelId(id)) return zenDisplayPin(id)?.contextWindow
    if (isMinimaxModelId(id)) return minimaxDisplayPin(id)?.contextWindow
    if (isTogetherModelId(id)) return togetherContextWindowFor(id)
    if (isCohereModelId(id)) return cohereModelFacts(id).contextWindow
    if (isGroqModelId(id)) return groqContextWindowFor(id)
    if (isMeliousModelId(id)) return meliousContextWindowFor(id)
    if (isCerebrasModelId(id)) return cerebrasContextWindowFor(id)
    if (isFireworksModelId(id)) return fireworksContextWindowFor(id)
    if (isQwenModelId(id)) return qwenModelFacts(id).contextWindow
    return undefined
  })()
  if (enginePinnedWindow !== undefined) {
    if (enginePinnedWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'static-pin',
        staticDefault: enginePinnedWindow,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: enginePinnedWindow,
      source: 'static-pin',
      staticDefault: enginePinnedWindow,
    })
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'capability',
        staticDefault: cap.max_input_tokens,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: cap.max_input_tokens,
      source: 'capability',
      staticDefault: cap.max_input_tokens,
    })
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return finish({ effectiveWindow: 1_000_000, source: 'beta-header' })
  }
  return finish({
    effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
    source: 'fallback',
    fallbackReason: 'no catalogue, pin, capability, beta, or experiment matched',
  })
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  return resolveContextWindow(model, betas).effectiveWindow
}

function rowInputMaximum(model: string): number | undefined {
  const id = normalizeForEnginePins(model)
  if (declaredRouteOf(model) === 'nous') {
    const openaiId = /^nous\/openai\/(.+)$/.exec(id)?.[1]
    return openaiId === undefined ? undefined : gptDisplayPin(openaiId)?.maxInputTokens
  }
  return isZenModelId(id) ? zenDisplayPin(id)?.maxInputTokens : gptDisplayPin(id)?.maxInputTokens
}

export function getModelInputCeiling(model: string, betas?: string[]): number {
  const base = baseResolveContextWindow(model, betas, 'default')
  const operator = operatorStatedWindow(model, base)
  const operatorDecides = operator !== undefined && operator.stated >= operator.floor
  const window = operatorDecides ? operator.stated : base.effectiveWindow
  const rowMaximumApplies = operatorDecides || base.source === 'static-pin' || declaredRouteOf(model) === 'nous'
  const maximum = rowMaximumApplies ? rowInputMaximum(model) : undefined
  return maximum === undefined ? window : Math.min(maximum, window)
}

function baseGetModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  const deepseekOut = declaredRouteOf(model) === 'deepseek' ? deepseekModelFacts(normalizeForEnginePins(model))?.outputMax : undefined
  if (deepseekOut !== undefined) return statedOutputTokens(deepseekOut)
  const metaOut = metaDisplayPin(model)?.outputMax
  if (metaOut !== undefined) return statedOutputTokens(metaOut)
  const zenOut = isZenModelId(model) ? zenDisplayPin(model)?.outputMax : undefined
  if (zenOut !== undefined) return statedOutputTokens(zenOut)
  const minimaxOut = isMinimaxModelId(model) ? minimaxDisplayPin(model)?.outputMax : undefined
  if (minimaxOut !== undefined) return statedOutputTokens(minimaxOut)
  const cohereOut = isCohereModelId(model) ? cohereModelFacts(model).outputMax : undefined
  if (cohereOut !== undefined) return statedOutputTokens(cohereOut)
  const orcarouterOut = isOrcarouterModelId(model) ? orcarouterListedModel(model)?.outputMax : undefined
  if (orcarouterOut !== undefined) return statedOutputTokens(orcarouterOut)
  const groqOut = isGroqModelId(model) ? groqOutputMaxFor(model) : undefined
  if (groqOut !== undefined) return statedOutputTokens(groqOut)
  const meliousOut = isMeliousModelId(model) ? meliousOutputMaxFor(model) : undefined
  if (meliousOut !== undefined) return statedOutputTokens(meliousOut)
  const cerebrasOut = isCerebrasModelId(model) ? cerebrasOutputMaxFor(model) : undefined
  if (cerebrasOut !== undefined) return statedOutputTokens(cerebrasOut)
  const fireworksOut = isFireworksModelId(model) ? fireworksOutputMaxFor(model) : undefined
  if (fireworksOut !== undefined) return statedOutputTokens(fireworksOut)
  const qwenOut = isQwenModelId(model) ? qwenModelFacts(model).outputMax : undefined
  if (qwenOut !== undefined) return statedOutputTokens(qwenOut)
  let upperLimit: number | undefined

  const gptPinOut = gptDisplayPin(model)?.outputMax
  if (gptPinOut !== undefined && gptPinOut >= 4_096) {
    return statedOutputTokens(gptPinOut)
  }

  const outputRoute = declaredRouteOf(model)
  if (outputRoute === 'openrouter' || outputRoute === 'gemini' || outputRoute === 'nous') {
    const statedOut = providerCapabilities()?.carrierOutputMaxFor(outputRoute, normalizeForEnginePins(model))
    if (statedOut !== undefined && statedOut >= 1_024) {
      return statedOutputTokens(statedOut)
    }
  }

  const m = isCarrierShapedId(model) ? '' : getCanonicalName(familyDefaultsModel(model))

  if (m.includes('fable-5')) {
    upperLimit = 128_000
  } else if (m === 'claude-haiku-5-5' || m.includes('sonnet-5') || m.includes('opus-5')) {
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    upperLimit = 64_000
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
  }

  if (upperLimit !== undefined) {
    return statedOutputTokens(upperLimit)
  }
  return { default: MAX_OUTPUT_TOKENS_DEFAULT, upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT }
}

export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}


export function getToolSearchBetaHeader(): string {
  return TOOL_SEARCH_BETA_HEADER_1P
}


const ALLOWED_SDK_BETAS: readonly string[] = [CONTEXT_1M_BETA_HEADER]

function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

function vetSdkBetas(betas: string[]): { kept: string[]; warnings: string[] } {
  if (isClaudeAISubscriber()) {
    return { kept: [], warnings: ['--provider-preview headers ride only on an API key; a subscription sign-in sends none of them.'] }
  }
  const { allowed, disallowed } = partitionBetasByAllowlist(betas)
  return {
    kept: allowed,
    warnings: disallowed.map(beta => `--provider-preview ${beta} is not a header Mercury sends; the ones it does: ${ALLOWED_SDK_BETAS.join(', ')}`),
  }
}

export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas?.length) return undefined
  const { kept, warnings } = vetSdkBetas(sdkBetas)
  for (const warning of warnings) {
    console.warn(warning)
  }
  return kept.length > 0 ? kept : undefined
}


const KEY_SEP = String.fromCharCode(0)

function betasEnvFingerprint(): string {
  return [
    flagEnv('MERCURY_DISABLE_1M_CONTEXT') ?? '',
    flagEnv('MERCURY_PROVIDER_BETAS') ?? '',
    isClaudeAISubscriber() ? 'subscription' : 'api-key',
  ].join(KEY_SEP)
}

const betasMemoKey = (model: string): string =>
  model + KEY_SEP + betasEnvFingerprint()

export const getAllModelBetas = memoize((model: string): string[] => {
  const betas: string[] = []
  if (!getCanonicalName(model).includes('haiku')) {
    betas.push(CODING_20250219_BETA_HEADER)
  }
  const subscriber = isClaudeAISubscriber()
  if (subscriber) {
    betas.push(OAUTH_BETA_HEADER)
  }
  if (
    has1mContext(model) &&
    modelSupports1M(model) &&
    !modelIsNatively1M(model) &&
    !context1mNeedsUnsentHeader(model) &&
    !subscriber
  ) {
    betas.push(CONTEXT_1M_BETA_HEADER)
  }
  const extra = flagEnv('MERCURY_PROVIDER_BETAS')
  if (extra) {
    for (const part of extra.split(',')) {
      const trimmed = part.trim()
      if (trimmed) betas.push(trimmed)
    }
  }
  return betas
}, betasMemoKey)

export const getModelBetas = memoize(
  (model: string): string[] => getAllModelBetas(model),
  betasMemoKey,
)

export function getMergedBetas(model: string, options?: { isAgenticQuery?: boolean }): string[] {
  const merged = Array.from(getModelBetas(model))
  const appendNew = (headers: readonly string[]): void => {
    const present = new Set(merged)
    headers.forEach(header => { if (!present.has(header)) merged.push(header) })
  }
  if (options?.isAgenticQuery) appendNew([CODING_20250219_BETA_HEADER])
  appendNew(getSdkBetas() ?? [])
  return merged
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
}
tellWhatClearsTheBetas(clearBetasCaches)


export function getModelKnowledgeCutoff(modelId: string): string | null {
  if (isCarrierShapedId(modelId)) return null
  if (familyHeadOf(modelId) !== null) return null
  if (getCanonicalName(modelId) === 'claude-haiku-5-5') return 'June 2026'
  if (modelId.includes('claude-opus-5-5') || modelId.includes('claude-sonnet-5-5')) {
    return 'June 2026'
  }
  if (modelId.includes('claude-opus-5')) {
    return 'May 2026'
  }
  if (modelId.includes('claude-opus-4-8')) {
    return 'January 2026'
  }
  if (getCanonicalName(modelId) === 'claude-fable-5-2') {
    return 'June 2026'
  }
  if (modelId.includes('claude-fable-5-1') || modelId.includes('claude-mythos-5-1')) {
    return 'June 2026'
  }
  if (modelId.includes('claude-fable-5') || modelId.includes('claude-mythos-5')) {
    return 'January 2026'
  }
  const canonical = getCanonicalName(modelId)
  if (canonical.includes('claude-sonnet-4-6')) {
    return 'August 2025'
  } else if (canonical.includes('claude-opus-4-6')) {
    return 'May 2025'
  } else if (canonical.includes('claude-opus-4-5')) {
    return 'May 2025'
  } else if (canonical.includes('claude-haiku-4')) {
    return 'February 2025'
  } else if (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4')
  ) {
    return 'January 2025'
  }
  return null
}


export function modelSupportsPDF(model: string): boolean {
  const route = declaredRouteOf(model)
  if (route === 'anthropic') return !model.toLowerCase().includes('claude-3-haiku')
  if (route === 'openai' || route === 'mistral') return catalogueDeclaresImages(model, route)
  if (route === 'gemini' && qualifiedWireId(model).startsWith('gemini-')) return catalogueDeclaresImages(model, route)
  return false
}

function baseModelReceivesImageBlocks(model: string): boolean {
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'unrecognised') return true
  if (verdict.kind === 'absence') return false
  return catalogueDeclaresImages(model, verdict.route)
}

function modalitiesAdmitImages(modalities: readonly string[] | undefined): boolean {
  return modalities === undefined || modalities.includes('image')
}

function catalogueDeclaresImages(model: string, route: CallModelRoute): boolean {
  switch (route) {
    case 'deepseek':
      return deepseekModelFacts(normalizeForEnginePins(model))?.images ?? true
    case 'xai':
      return xaiModelFacts(model)?.images === true
    case 'meta':
      return metaDisplayPin(model)?.images === true
    case 'mistral':
      return mistralModelFacts(model).images === true
    case 'zen':
      return zenDisplayPin(model)?.images === true
    case 'minimax':
      return minimaxDisplayPin(model)?.images === true
    case 'together':
      return togetherDisplayPin(model)?.images === true
    case 'cohere':
      return cohereModelFacts(model).images === true
    case 'groq':
      return groqDisplayPin(model)?.images === true
    case 'melious':
      return meliousListedModel(model)?.images === true
    case 'orcarouter':
      return modalitiesAdmitImages(orcarouterListedModel(model)?.inputModalities)
    case 'cerebras':
      return cerebrasDisplayPin(model)?.images === true
    case 'fireworks':
      return fireworksDisplayPin(model)?.images === true
    case 'qwen':
      return qwenDisplayPin(model)?.images === true
    case 'zai':
      return glmTakesImages(model)
    case 'openrouter':
      return modalitiesAdmitImages(providerCapabilities()?.openrouterInputModalities(model))
    case 'huggingface':
      return modalitiesAdmitImages(providerCapabilities()?.huggingfaceInputModalities(qualifiedWireId(model)))
    case 'local':
      return providerCapabilities()?.localVisionDeclared(model) ?? false
    case 'nous':
      return modalitiesAdmitImages(providerCapabilities()?.nousInputModalities(model))
    case 'openai':
      return modalitiesAdmitImages(providerCapabilities()?.liveGptInputModalities(normalizeForEnginePins(model)))
    case 'gemini':
      return providerCapabilities()?.geminiDeclaresImages(model) ?? true
    default:
      return true
  }
}


export function fineGrainedToolStreamingEnabled(): boolean {
  if (!isFirstPartyAnthropicBaseUrl()) {
    return false
  }
  return flagEnabled('MERCURY_FGTS')
}

export function toolDeferralEnabled(): boolean {
  return flagEnabled('MERCURY_TOOL_DEFER')
}


type ModelCapabilityRecord = Readonly<{
  model: string
  canonical: string
  identity: Readonly<{
    isHaiku: boolean
    knowledgeCutoff: string | null
  }>
  context: Readonly<{
    window: number
    supports1m: boolean
    outputDefault: number
    outputMax: number
    maxThinkingTokens: number
  }>
  thinking: Readonly<{
    supported: boolean
    adaptive: boolean
    interleaved: boolean
  }>
  sampling: Readonly<{ temperature: boolean }>
  effort: Readonly<{
    supported: boolean
    max: boolean
    xhigh: boolean
    ceiling: EffortLevel
  }>
  tools: Readonly<{
    structuredOutputs: boolean
    toolSearchBetaHeader: string
  }>
  media: Readonly<{ pdf: boolean; images: boolean }>
  betas: Readonly<{
    all: readonly string[]
    headers: readonly string[]
  }>
}>

export function resolveModelCapabilities(model: string): ModelCapabilityRecord {
  const canonical = getCanonicalName(model)
  const outputTokens = getModelMaxOutputTokens(model)
  return Object.freeze({
    model,
    canonical,
    identity: Object.freeze({
      isHaiku: canonical.includes('haiku'),
      knowledgeCutoff: getModelKnowledgeCutoff(model),
    }),
    context: Object.freeze({
      window: getContextWindowForModel(model),
      supports1m: modelSupports1M(model),
      outputDefault: outputTokens.default,
      outputMax: outputTokens.upperLimit,
      maxThinkingTokens: getMaxThinkingTokensForModel(model),
    }),
    thinking: Object.freeze({
      supported: modelSupportsThinking(model),
      adaptive: modelSupportsAdaptiveThinking(model),
      interleaved: modelSupportsISP(model),
    }),
    sampling: Object.freeze({ temperature: modelSupportsTemperature(model) }),
    effort: Object.freeze({
      supported: modelSupportsEffort(model),
      max: modelSupportsMaxEffort(model),
      xhigh: modelSupportsXHighEffort(model),
      ceiling: getMaxSupportedEffortLevel(model),
    }),
    tools: Object.freeze({
      structuredOutputs: modelSupportsStructuredOutputs(model),
      toolSearchBetaHeader: getToolSearchBetaHeader(),
    }),
    media: Object.freeze({
      pdf: modelSupportsPDF(model),
      images: modelReceivesImageBlocks(model),
    }),
    betas: Object.freeze({
      all: Object.freeze([...getAllModelBetas(model)]),
      headers: Object.freeze([...getModelBetas(model)]),
    }),
  })
}

export function modelSupportsThinking(model: string): boolean {
  const base = baseModelSupportsThinking(model)
  const stated = operatorModelFacts(model)?.reasoning
  return stated === undefined ? base : stated || (modelHasRecordedFacts(model) && base)
}

export function modelReceivesImageBlocks(model: string): boolean {
  const base = baseModelReceivesImageBlocks(model)
  const routeVerdict = classifyModelRoute(model)
  const recordedImages =
    routeVerdict.kind === 'route' && routeVerdict.route === 'openai'
      ? (() => {
          const mods = providerCapabilities()?.liveGptInputModalities(normalizeForEnginePins(model))
          return mods !== undefined ? mods.includes('image') : undefined
        })()
      : undefined
  const stated = operatorModelFacts(model, ...(recordedImages !== undefined ? [{ images: recordedImages }] : []))?.images
  return stated === undefined ? base : stated || ((modelHasRecordedFacts(model) || recordedImages === true) && base)
}

export function effortVocabularyFor(model: string): EffortVocabularyView {
  const base = baseEffortVocabularyFor(model)
  if (declaredRouteOf(model) === 'openai-compat') return base
  const stated = operatorModelFacts(model)?.efforts
  if (stated === undefined || (base.kind === 'provider' && base.source === 'gpt-live')) return base
  const floor = modelHasRecordedFacts(model) ? ('vocabulary' in base ? base.vocabulary : base.kind === 'offered' ? EFFORT_LEVELS : []) : []
  const vocabulary = [...new Set([...floor, ...stated])]
  return { kind: 'provider', source: 'operator', vocabulary, thinkingGated: base.kind === 'provider' && base.thinkingGated,
    ...(base.kind === 'provider' && base.thinkingOffWire !== undefined ? { thinkingOffWire: base.thinkingOffWire } : {}) }
}

function operatorStatedWindow(model: string, base: ContextResolution): { stated: number; floor: number } | undefined {
  const stated = operatorModelFacts(model, base.source === 'live-current' ? { contextWindow: base.effectiveWindow } : {})?.contextWindow
  if (stated === undefined) return undefined
  const floor = declaredRouteOf(model) !== 'openai-compat' && (modelHasRecordedFacts(model) || base.source === 'live-current') ? base.effectiveWindow : 0
  return { stated, floor }
}

export function resolveContextWindow(model: string, betas?: string[], requestedMode: ContextRequestedMode = 'default'): ContextResolution {
  const base = baseResolveContextWindow(model, betas, requestedMode)
  const operator = operatorStatedWindow(model, base)
  if (operator === undefined) return base
  return { ...base, effectiveWindow: Math.max(operator.stated, operator.floor), source: 'operator', pinAwaitingLive: false, fallbackReason: undefined }
}

export function getModelMaxOutputTokens(model: string): { default: number; upperLimit: number } {
  const base = baseGetModelMaxOutputTokens(model)
  const stated = operatorModelFacts(model)?.maxOutputTokens
  if (stated === undefined) return base
  const upperLimit = Math.max(stated, modelHasRecordedFacts(model) ? base.upperLimit : 0)
  return { default: upperLimit, upperLimit }
}
