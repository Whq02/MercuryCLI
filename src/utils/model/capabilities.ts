import memoize from 'lodash-es/memoize.js'
import {
  checkFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/featureGates.js'
import { flagEnabled } from 'src/substrate/flagRegistry.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../entrypoints/sdk/runtimeTypes.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../../bootstrap/state.js'
import {
  CODING_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  SERVER_SIDE_FALLBACK_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
} from '../../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { isClaudeAISubscriber } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import {
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../envUtils.js'
import { getCanonicalName } from './model.js'
import { getModelCapability } from './modelCapabilities.js'
import { AUGUR_BETA_HEADER, isAugurHeader } from './augur.js'
import { isCarrierShapedId } from '../../services/providers/idSpaces.js'
import {
  gptDisplayPin,
  hasGptServedWindowSuffix,
  parseGptModelId,
} from '../../services/providers/openai/gptPins.js'
import {
  liveGptContextWindow,
  liveGptContextCeiling,
  liveGptDefaultEffort,
  liveGptEffortCatalogue,
} from '../../services/providers/openai/openaiCatalogue.js'
import {
  glmEffortsFor,
  isGlmModelId,
} from '../../services/providers/zai/glmPins.js'
import {
  isKimiModelId,
  kimiDisplayPin,
  KIMI_EFFORTS,
  KIMI_EFFORT_MODELS,
} from '../../services/providers/moonshot/kimiPins.js'
import { thinkingOffWireEffort } from '../../services/providers/openaicompat/compatWire.js'
import {
  deepseekDisplayPin,
  DEEPSEEK_EFFORTS,
  isDeepseekModelId,
} from '../../services/providers/deepseek/deepseekPins.js'
import { isHuggingfaceModelId } from '../../services/providers/huggingface/huggingfacePins.js'
import { classifyModelRoute, declaredRouteOf } from '../../services/providers/routeLaw.js'
import { isFirstPartyAnthropicBaseUrl } from './providers.js'
import { getInitialSettings } from '../settings/settings.js'


export function modelSupportsTemperature(model: string): boolean {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model)
  if (!m) return true
  const family = m[1]!
  const major = parseInt(m[2]!, 10)
  const minor = m[3] !== undefined ? parseInt(m[3], 10) : 0
  if (major >= 5) return false
  if (family === 'opus' && major === 4 && minor >= 7) return false
  return true
}


export function modelSupportsISP(model: string): boolean {
  return !getCanonicalName(model).includes('claude-3-')
}

export function modelSupportsThinking(model: string): boolean {
  return !getCanonicalName(model).includes('claude-3-')
}

export function modelSupportsAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  if (canonical.includes('sonnet-5') || canonical.includes('opus-5')) {
    return true
  }
  if (canonical.includes('fable-5') || canonical.includes('mythos-5')) {
    return true
  }
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
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
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(model)
  return canonical.includes('fable-5') || canonical.includes('mythos-5')
}

export function modelSupportsForcedToolChoice(model: string): boolean {
  if (isCarrierShapedId(model)) return true
  return getCanonicalName(model) !== 'claude-fable-5-1'
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


export function modelSupportsContextManagement(model: string): boolean {
  return !getCanonicalName(model).includes('claude-3-')
}

export function modelSupportsStructuredOutputs(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  const canonical = getCanonicalName(model)
  return (
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

const perMessageEffortRefused = new Set<string>()

export function notePerMessageEffortRefused(model: string): void {
  perMessageEffortRefused.add(getCanonicalName(model))
}

export function resetPerMessageEffortRefusals(): void {
  perMessageEffortRefused.clear()
}

export function refusesPerMessageEffortRow(errorText: string): boolean {
  return /mid-conversation-output-config|output_config/i.test(errorText)
}

export function servesPerMessageEffort(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  const canonical = getCanonicalName(model)
  if (perMessageEffortRefused.has(canonical)) return false
  return canonical.includes('claude-fable-5-1') || canonical.includes('claude-mythos-5-1')
}

export function modelSupportsAutoMode(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return true
  {
    const m = getCanonicalName(model)
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowModels?: string[]
    }>('mercury_auto_mode_config', {})
    const rawLower = model.toLowerCase()
    if (
      config?.allowModels?.some(
        am => am.toLowerCase() === rawLower || am.toLowerCase() === m,
      )
    ) {
      return true
    }

    return (
      /^claude-(opus|sonnet)-4-6/.test(m) ||
      m === 'claude-fable-5' ||
      m === 'claude-fable-5-1'
    )
  }
}


export type GptEffortVocabularyView =
  | { state: 'not-gpt' }
  | { state: 'live'; vocabulary: readonly string[]; defaultEffort?: string }
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

export type EffortVocabularyView =
  | { kind: 'ladder'; source: 'first-party' | 'unknown-id'; vocabulary: readonly EffortLevel[] }
  | {
      kind: 'provider'
      source: 'gpt-live' | 'glm' | 'kimi' | 'deepseek' | 'gemini' | 'openrouter' | 'local'
      vocabulary: readonly string[]
      defaultEffort?: string
      thinkingGated: boolean
      thinkingOffWire?: string
    }
  | { kind: 'offered'; source: 'gpt-unstated' | 'gpt-unavailable'; defaultEffort?: string }
  | {
      kind: 'none'
      source:
        | 'gpt-known-empty'
        | 'glm'
        | 'kimi'
        | 'huggingface'
        | 'openrouter'
        | 'gemini'
        | 'compat'
        | 'local'
        | 'carrier'
        | 'first-party-legacy'
      defaultEffort?: string
    }

const FIRST_PARTY_FULL_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const FIRST_PARTY_LADDER_TO_MAX: readonly EffortLevel[] = ['low', 'medium', 'high', 'max']
const UNKNOWN_ID_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high']

export function effortVocabularyFor(model: string): EffortVocabularyView {
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
  if (isKimiModelId(model)) {
    return KIMI_EFFORT_MODELS.has(model.trim().toLowerCase())
      ? { kind: 'provider', source: 'kimi', vocabulary: [...KIMI_EFFORTS], thinkingGated: false }
      : { kind: 'none', source: 'kimi' }
  }
  if (isDeepseekModelId(model)) {
    return { kind: 'provider', source: 'deepseek', vocabulary: [...DEEPSEEK_EFFORTS], thinkingGated: true }
  }
  if (isHuggingfaceModelId(model)) return { kind: 'none', source: 'huggingface' }
  const route = declaredRouteOf(model)
  if (route === 'openrouter') {
    const { openrouterEffortVocabularyFor } =
      require('../../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../../services/providers/openrouter/openrouterCatalogue.js')
    const vocabulary = openrouterEffortVocabularyFor(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'openrouter', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'openrouter' }
  }
  if (route === 'gemini') {
    const { geminiEffortVocabularyFor } =
      require('../../services/providers/gemini/geminiCatalogue.js') as typeof import('../../services/providers/gemini/geminiCatalogue.js')
    const vocabulary = geminiEffortVocabularyFor(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'gemini', vocabulary, thinkingGated: true, thinkingOffWire: thinkingOffWireEffort(vocabulary) }
      : { kind: 'none', source: 'gemini' }
  }
  if (route === 'openai-compat') return { kind: 'none', source: 'compat' }
  if (model.trim().toLowerCase().startsWith('local/')) {
    const { localRecordFor } =
      require('../../services/providers/local/localCatalogue.js') as typeof import('../../services/providers/local/localCatalogue.js')
    const { localModelAcceptsEffort } =
      require('../../services/providers/local/localCallModel.js') as typeof import('../../services/providers/local/localCallModel.js')
    const { LOCAL_SERVER_EFFORTS } =
      require('../../services/providers/openaicompat/compatWire.js') as typeof import('../../services/providers/openaicompat/compatWire.js')
    const record = localRecordFor(model)
    const vocabulary = record && localModelAcceptsEffort(record) ? LOCAL_SERVER_EFFORTS[record.server] : []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'local', vocabulary, thinkingGated: false }
      : { kind: 'none', source: 'local' }
  }
  if (isCarrierShapedId(model)) return { kind: 'none', source: 'carrier' }
  const m = model.toLowerCase()
  if (
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

export function gptModelDefaultEffortRaw(model: string): string | undefined {
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

export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.MERCURY_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('fable-5')
  )
}


export type ContextRequestedMode = 'default' | 'maximum'

export type ContextActivation =
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
    | 'suffix-1m'
    | 'live-current'
    | 'static-pin'
    | 'capability'
    | 'beta-header'
    | 'experiment'
    | 'fallback'
  outputReserve: number
  fallbackReason?: string
}

function normalizeForEnginePins(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]/g, '')
}

export function resolveContextWindow(
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
    if (isCarrierShapedId(model)) {
      const base = resolveContextWindow(model.replace(/\[1m\]/i, ''), betas, requestedMode)
      return {
        ...base,
        model,
        activation: {
          kind: 'unavailable',
          reason: '[1m] is not a provider-verified activation path on a carrier-shaped id',
        },
        fallbackReason: 'unverified [1m] suffix ignored; resolved as the base id',
      }
    }
    const gptBase = model.replace(/\[1m\]/i, '')
    if (!parseGptModelId(gptBase)) {
      return finish({ effectiveWindow: 1_000_000, source: 'suffix-1m' })
    }
    const base = resolveContextWindow(gptBase, betas, requestedMode)
    return {
      ...base,
      model,
      activation: {
        kind: 'unavailable',
        reason: '[1m] is not a provider-verified activation path for GPT engine ids (CX-14)',
      },
      fallbackReason: 'unverified [1m] suffix ignored; resolved as the base id',
    }
  }

  const carrierRoute = declaredRouteOf(model)
  if (carrierRoute === 'openrouter' || carrierRoute === 'gemini') {
    const stated =
      carrierRoute === 'openrouter'
        ? (
            require('../../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../../services/providers/openrouter/openrouterCatalogue.js')
          ).openrouterContextWindowFor(normalizeForEnginePins(model))
        : (
            require('../../services/providers/gemini/geminiCatalogue.js') as typeof import('../../services/providers/gemini/geminiCatalogue.js')
          ).geminiContextWindowFor(normalizeForEnginePins(model))
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
      fallbackReason: `the ${carrierRoute === 'openrouter' ? 'OpenRouter' : 'Gemini'} catalogue states no context length for this model (or is not fetched yet) — conservative default`,
    })
  }

  const firstPartyCanonical = getCanonicalName(model)
  if (
    !isCarrierShapedId(model) &&
    (firstPartyCanonical.includes('sonnet-5') ||
      firstPartyCanonical.includes('opus-5') ||
      firstPartyCanonical === 'claude-fable-5-1')
  ) {
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
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: gptPin.contextWindow,
      source: 'static-pin',
      staticDefault: gptPin.contextWindow,
    })
  }

  if (isHuggingfaceModelId(model)) {
    const { huggingfaceContextWindowFor } =
      require('../../services/providers/huggingface/huggingfaceCatalogue.js') as typeof import('../../services/providers/huggingface/huggingfaceCatalogue.js')
    const stated = huggingfaceContextWindowFor(normalizeForEnginePins(model))
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
  }

  if (model.trim().toLowerCase().startsWith('local/')) {
    const { localRecordFor, localContextSourceWords } =
      require('../../services/providers/local/localCatalogue.js') as typeof import('../../services/providers/local/localCatalogue.js')
    const record = localRecordFor(normalizeForEnginePins(model))
    if (record?.contextWindow) {
      const window = record.contextWindow.tokens
      const note = `local server context: ${localContextSourceWords(record.contextWindow.source)}`
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
        ...(record.contextWindow.source === 'served' ? {} : { fallbackReason: note }),
      })
    }
    return finish({
      effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
      source: 'fallback',
      fallbackReason: record
        ? 'the local server states no context length for this model — conservative default'
        : 'local model not discovered yet — conservative default until a probe answers',
    })
  }

  const enginePinnedWindow = (() => {
    const id = normalizeForEnginePins(model)
    if (isGlmModelId(id)) {
      const { GLM_STATIC_CATALOGUE } =
        require('../router/providers/zai.js') as typeof import('../router/providers/zai.js')
      return GLM_STATIC_CATALOGUE.find(e => e.id === id)?.contextWindow
    }
    if (isKimiModelId(id)) return kimiDisplayPin(id)?.contextWindow
    if (isDeepseekModelId(id)) return deepseekDisplayPin(id)?.contextWindow
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
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return finish({ effectiveWindow: 1_000_000, source: 'experiment' })
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

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  const gptPinOut = gptDisplayPin(model)?.outputMax
  if (gptPinOut !== undefined && gptPinOut >= 4_096) {
    return { default: Math.min(64_000, gptPinOut), upperLimit: gptPinOut }
  }

  const outputRoute = declaredRouteOf(model)
  if (outputRoute === 'openrouter' || outputRoute === 'gemini') {
    const statedOut =
      outputRoute === 'openrouter'
        ? (
            require('../../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../../services/providers/openrouter/openrouterCatalogue.js')
          ).openrouterMaxCompletionTokensFor(normalizeForEnginePins(model))
        : (
            require('../../services/providers/gemini/geminiCatalogue.js') as typeof import('../../services/providers/gemini/geminiCatalogue.js')
          ).geminiOutputTokenLimitFor(normalizeForEnginePins(model))
    if (statedOut !== undefined && statedOut >= 1_024) {
      return { default: Math.min(MAX_OUTPUT_TOKENS_DEFAULT, statedOut), upperLimit: statedOut }
    }
  }

  const m = isCarrierShapedId(model) ? '' : getCanonicalName(model)

  if (m.includes('fable-5')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-5') || m.includes('opus-5')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}


export function getToolSearchBetaHeader(): string {
  return TOOL_SEARCH_BETA_HEADER_1P
}


const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

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

export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  if (isClaudeAISubscriber()) {
    console.warn(
      'Warning: Custom betas are only available for API key users. Ignoring provided betas.',
    )
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    console.warn(
      `Warning: Beta header '${beta}' is not allowed. Only the following betas are supported: ${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return !isEnvTruthy('1')
}

export function shouldUseGlobalCacheScope(): boolean {
  return !isEnvTruthy('1')
}

const KEY_SEP = String.fromCharCode(0)

function betasEnvFingerprint(): string {
  return [
    process.env.DISABLE_INTERLEAVED_THINKING ?? '',
    process.env.MERCURY_DISABLE_1M_CONTEXT ?? '',
    process.env.ANTHROPIC_BETAS ?? '',
  ].join(KEY_SEP)
}

const betasMemoKey = (model: string): string =>
  model + KEY_SEP + betasEnvFingerprint()

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas()

  if (!isHaiku) {
    betaHeaders.push(CODING_20250219_BETA_HEADER)

  }
  if (isClaudeAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  if (
    SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER &&
    false &&
    includeFirstPartyOnlyBetas &&
    !isEnvDefinedFalsy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) &&
    (isEnvTruthy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) ||
      getFeatureValue_CACHED_MAY_BE_STALE('mercury_connector_text_summarization', false))
  ) {
    betaHeaders.push(SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER)
  }

  const antOptedIntoToolClearing =
    isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) &&
    false

  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (
    shouldIncludeFirstPartyOnlyBetas() &&
    (antOptedIntoToolClearing || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }

  if (includeFirstPartyOnlyBetas && isAugurHeader()) {
    betaHeaders.push(AUGUR_BETA_HEADER)
  }
  const strictToolsEnabled =
    checkFeatureGate_CACHED_MAY_BE_STALE('mercury_tool_pear')
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
}, betasMemoKey)

export const getModelBetas = memoize((model: string): string[] => {
  return getAllModelBetas(model)
}, betasMemoKey)

export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(CODING_20250219_BETA_HEADER)) {
      baseBetas.push(CODING_20250219_BETA_HEADER)
    }

  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
}


export function modelSupportsServerSideFallback(model: string): boolean {
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(model)
  return (
    canonical === 'claude-fable-5-1' ||
    canonical === 'claude-fable-5' ||
    canonical === 'claude-opus-5'
  )
}

export function refusalFallbackEnabled(): boolean {
  return flagEnabled('MERCURY_REFUSAL_FALLBACK')
}

export function refusalFallbackRequest(
  model: string,
): { beta: string; fallbacks: 'default' } | null {
  if (!refusalFallbackEnabled()) return null
  if (!modelSupportsServerSideFallback(model)) return null
  return { beta: SERVER_SIDE_FALLBACK_BETA_HEADER, fallbacks: 'default' }
}


export function getModelKnowledgeCutoff(modelId: string): string | null {
  if (isCarrierShapedId(modelId)) return null
  if (modelId.includes('claude-opus-5')) {
    return 'May 2026'
  }
  if (modelId.includes('claude-opus-4-8')) {
    return 'January 2026'
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
  if (declaredRouteOf(model) !== 'anthropic') return false
  return !model.toLowerCase().includes('claude-3-haiku')
}

export function modelReceivesImageBlocks(model: string): boolean {
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'unrecognised') return true
  if (verdict.kind === 'absence') return false
  return verdict.route === 'anthropic' || verdict.route === 'openai'
}


export function toolSearchPassthroughUncertain(): boolean {
  return !isFirstPartyAnthropicBaseUrl()
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


export function modelSupportsAdvisor(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    false
  )
}

export function isValidAdvisorModel(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    false
  )
}


export type ModelCapabilityRecord = Readonly<{
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
    ultra: boolean
    ceiling: EffortLevel
  }>
  tools: Readonly<{
    structuredOutputs: boolean
    contextManagement: boolean
    autoMode: boolean
    toolSearchBetaHeader: string
    advisor: boolean
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
      ultra: modelOffersEffortLevel(model, 'ultra'),
      ceiling: getMaxSupportedEffortLevel(model),
    }),
    tools: Object.freeze({
      structuredOutputs: modelSupportsStructuredOutputs(model),
      contextManagement: modelSupportsContextManagement(model),
      autoMode: modelSupportsAutoMode(model),
      toolSearchBetaHeader: getToolSearchBetaHeader(),
      advisor: modelSupportsAdvisor(model),
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
