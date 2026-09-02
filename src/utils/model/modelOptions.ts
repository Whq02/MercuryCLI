import { flagEnv } from '../../substrate/flagRegistry.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getGlobalConfig } from '../config.js'
import {
  evaluateGptCandidate,
  getGptSeatAvailability,
  qualifiedGptCandidates,
  GPT_DISPLAY_PINS,
  type GptDisqualification,
  type GptSeatAvailability,
} from '../../services/providers/openai/openaiCatalogue.js'
import {
  GEMINI_CONNECT_OPTION_VALUE,
  GEMINI_MODEL_GROUP,
  getGeminiModelOptions,
} from '../../services/providers/gemini/geminiCatalogue.js'
import {
  OPENROUTER_CONNECT_OPTION_VALUE,
  OPENROUTER_MODEL_GROUP,
  getOpenrouterModelOptions,
} from '../../services/providers/openrouter/openrouterCatalogue.js'
import { connectToBrowseReason } from '../../services/providers/catalogueGate.js'
import { isCarrierShapedId } from '../../services/providers/idSpaces.js'
import {
  HUGGINGFACE_CONNECT_OPTION_VALUE,
  HUGGINGFACE_MODEL_GROUP,
  getHuggingfaceModelOptions,
} from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { LOCAL_MODEL_GROUP, getLocalModelOptions } from '../../services/providers/local/localCatalogue.js'
import { has1mContext, modelSupports1M } from './capabilities.js'
import {
  NO_SIGN_IN_REASON,
  computedDefault,
  describeComputedDefaultRow,
} from './computedDefault.js'
import {
  getBestModel,
  getDefaultSonnetModel,
  getCanonicalName,
  getMarketingNameForModel,
  isDefaultOpusNatively1M,
  isOpus1mMergeEnabled,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
  renderModelName,
} from './model.js'
import { getModelStrings } from './modelStrings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { isModelAllowed } from './modelAllowlist.js'
import { isClaudeAISubscriber, isMaxSubscriber, isTeamPremiumSubscriber } from '../auth.js'
import { isFableAvailable } from './model.js'

export type ModelOption = {
  value: string | null
  label: string
  description: string
  descriptionForModel?: string
  group?: string
  unavailable?: string
  statedContextWindow?: number
}

export const GPT_CONNECT_OPTION_VALUE = '__hermes_gpt_connect__'
export const ANTHROPIC_CONNECT_OPTION_VALUE = '__mercury_anthropic_connect__'

export interface ModelOptionReads {
  anthropicCredentialed?: () => boolean
}

function liveAnthropicCredentialed(): boolean {
  const { anthropicCredentialPresence } =
    require('../../services/providers/providerUsage.js') as typeof import('../../services/providers/providerUsage.js')
  return anthropicCredentialPresence().credentialed
}

export function anthropicNotSignedInReason(): string {
  const { subModelConnectHome } =
    require('./subModelSlots.js') as typeof import('./subModelSlots.js')
  const home = subModelConnectHome('anthropic')
  return `not signed in — ${home.command ?? home.note}`
}

export { getGptSeatAvailability }
export type { GptSeatAvailability }


const TRAILING_1M_RE = /\[1m\]$/i
const ANY_1M_RE = /\[1m\]/gi

export function withContext1m(value: string): string {
  if (TRAILING_1M_RE.test(value)) return value
  return `${value}[1m]`
}

export function stripContext1m(value: string): string {
  return value.replace(ANY_1M_RE, '')
}


const DEFAULT_LABEL = 'Recommended'

function defaultRow(): ModelOption {
  const { providerDisplayName } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  return {
    value: null,
    label: DEFAULT_LABEL,
    description: describeComputedDefaultRow(computedDefault(), providerDisplayName),
  }
}


function aliasRow(alias: string, description: string): ModelOption {
  return { value: alias, label: renderModelName(parseUserSpecifiedModel(alias)), description }
}

function literalRow(id: string, description: string): ModelOption {
  return { value: id, label: renderModelName(id), description }
}

function getFableOption(): ModelOption {
  return {
    value: 'fable',
    label: renderModelName(parseUserSpecifiedModel('fable')),
    description: '',
  }
}

function getFable51Option(): ModelOption {
  return literalRow(getModelStrings().fable51, '')
}

function getOpusFrontierFallbackOption(): ModelOption {
  return {
    value: 'opus',
    label: renderModelName(parseUserSpecifiedModel('opus')),
    description: '',
  }
}

function suffixedMidRow(): ModelOption | null {
  if (has1mContext(getDefaultSonnetModel())) return null
  if (!checkSonnet1mAccess()) return null
  return aliasRow('sonnet[1m]', '')
}

const PREVIOUS_LARGE_KEYS = ['opus48', 'opus47', 'opus46'] as const

function previousGenerationLargeRows(): ModelOption[] {
  const rows: ModelOption[] = []
  const strings = getModelStrings()
  const currentLarge = normalizeModelStringForAPI(parseUserSpecifiedModel('opus'))
  for (const key of PREVIOUS_LARGE_KEYS) {
    const id = strings[key]
    if (normalizeModelStringForAPI(id) === currentLarge) continue
    rows.push(literalRow(id, ''))
    if (checkOpus1mAccess()) {
      rows.push(literalRow(withContext1m(id), ''))
    }
  }
  return rows
}

function largeModelShapeRows(): ModelOption[] {
  if (isDefaultOpusNatively1M()) {
    return [aliasRow('opus', '')]
  }
  if (isOpus1mMergeEnabled()) {
    return [aliasRow('opus[1m]', '')]
  }
  const rows = [aliasRow('opus', '')]
  if (checkOpus1mAccess()) {
    rows.push(aliasRow('opus[1m]', ''))
  }
  return rows
}

function premiumSubscriberTierRows(): ModelOption[] {
  const rows: ModelOption[] = [defaultRow()]
  rows.push(getFableOption())
  rows.push(getFable51Option())
  if (isFableAvailable()) {
    rows.push(getOpusFrontierFallbackOption())
  }
  if (!isDefaultOpusNatively1M() && !isOpus1mMergeEnabled() && checkOpus1mAccess()) {
    rows.push(aliasRow('opus[1m]', ''))
  }
  rows.push(...previousGenerationLargeRows())
  rows.push(aliasRow('sonnet', ''))
  const suffixedMid = suffixedMidRow()
  if (suffixedMid !== null) rows.push(suffixedMid)
  rows.push(aliasRow('haiku', ''))
  return rows
}

function standardShapeTierRows(): ModelOption[] {
  const rows: ModelOption[] = [defaultRow()]
  rows.push(getFableOption())
  rows.push(getFable51Option())
  const suffixedMid = suffixedMidRow()
  if (suffixedMid !== null) rows.push(suffixedMid)
  rows.push(...largeModelShapeRows())
  rows.push(...previousGenerationLargeRows())
  rows.push(aliasRow('haiku', ''))
  return rows
}

function baseTierRows(): ModelOption[] {
  return isClaudeAISubscriber() && (isMaxSubscriber() || isTeamPremiumSubscriber())
    ? premiumSubscriberTierRows()
    : standardShapeTierRows()
}


function collectStringValues(options: ModelOption[]): Set<string> {
  const values = new Set<string>()
  for (const option of options) {
    if (typeof option.value === 'string') values.add(option.value)
  }
  return values
}

function isSentinelValue(v: string): boolean {
  if (v === GPT_CONNECT_OPTION_VALUE) return true
  return v.startsWith('__') || v.includes(':')
}

function resolveWithSuffix(value: string): string {
  const suffix = TRAILING_1M_RE.test(value) ? '[1m]' : ''
  const resolved = parseUserSpecifiedModel(stripContext1m(value))
  return TRAILING_1M_RE.test(resolved) ? resolved : `${resolved}${suffix}`
}

export function resolvesToExistingOption(options: ModelOption[], candidate: string): boolean {
  if (isSentinelValue(candidate)) return false
  const candidateResolved = resolveWithSuffix(candidate)
  for (const option of options) {
    const value = option.value
    if (typeof value !== 'string') continue
    if (isSentinelValue(value)) continue
    if (value === candidate) continue
    if (resolveWithSuffix(value) === candidateResolved) return true
  }
  return false
}

function dedupOneModelOneRow(options: ModelOption[]): ModelOption[] {
  const collected = collectStringValues(options)
  return options.filter(option => {
    const value = option.value
    if (typeof value !== 'string' || isSentinelValue(value)) return true
    const bare = stripContext1m(value)
    const resolved = parseUserSpecifiedModel(bare)
    if (resolved === bare) return true
    return !collected.has(resolved)
  })
}

function pushIfAbsent(options: ModelOption[], row: ModelOption): void {
  if (row.value !== null && options.some(existing => existing.value === row.value)) return
  options.push(row)
}

export const ANTHROPIC_MODEL_GROUP = 'Mercury — Anthropic models'
export const OPENAI_MODEL_GROUP = 'Mercury — OpenAI models'
export const ZAI_MODEL_GROUP = 'Mercury — Z.AI models'
export const MOONSHOT_MODEL_GROUP = 'Mercury — Moonshot models'
export const DEEPSEEK_MODEL_GROUP = 'Mercury — DeepSeek models'
export const COMPAT_MODEL_GROUP = 'Mercury — custom endpoint'

export const KEY_CONNECT_PREFIX = '__mercury_connect__:'
export function keyConnectValue(provider: 'zai' | 'moonshot' | 'deepseek' | 'compat'): string {
  return `${KEY_CONNECT_PREFIX}${provider}`
}
export function parseKeyConnectValue(
  value: string,
): 'zai' | 'moonshot' | 'deepseek' | 'compat' | undefined {
  if (!value.startsWith(KEY_CONNECT_PREFIX)) return undefined
  const provider = value.slice(KEY_CONNECT_PREFIX.length)
  return provider === 'zai' || provider === 'moonshot' || provider === 'deepseek' || provider === 'compat'
    ? provider
    : undefined
}

export function isProviderActionRow(value: string): boolean {
  return (
    value === GPT_CONNECT_OPTION_VALUE ||
    value.startsWith(KEY_CONNECT_PREFIX) ||
    /^__mercury_[a-z0-9-]+_connect__$/.test(value)
  )
}

function gptDisqualificationCopy(
  why: GptDisqualification,
  sourceLabel: string,
  pin?: { availabilityNote?: string },
): string {
  switch (why.reason) {
    case 'not-in-live-catalogue':
      return pin?.availabilityNote
        ? `not served by the connected ${sourceLabel} — ${pin.availabilityNote}`
        : `not served by the connected ${sourceLabel}`
    case 'hidden-or-retired':
      return `hidden by the account source (${why.detail})`
    case 'effort-catalogue-undecodable':
      return 'effort catalogue undecodable'
    case 'catalogue-unavailable':
      return `live catalogue unavailable${why.detail ? ` (${why.detail})` : ''}`
    case 'account-source-unavailable':
    case 'not-gpt-family':
    case 'unparseable-id':
      return 'not offered here'
  }
}

function unavailableGptRow(
  pin: (typeof GPT_DISPLAY_PINS)[number],
  reason: string,
): ModelOption {
  return {
    value: pin.id,
    label: pin.displayName,
    description: '',
    descriptionForModel: `${pin.displayName} (${pin.id}) — in the current OpenAI lineup but NOT selectable here: ${reason}.`,
    group: OPENAI_MODEL_GROUP,
    unavailable: reason,
    ...(pin.contextWindow !== undefined ? { statedContextWindow: pin.contextWindow } : {}),
  }
}

function getQualifiedGptOptions(): ModelOption[] {
  const availability = getGptSeatAvailability()
  if (availability.state !== 'ready') {
    const reason = availability.state === 'disabled' ? availability.reason : ''
    const signIn = availability.why === 'no-account' || availability.why === 'auth-expired'
    const label = signIn
      ? 'GPT — sign in'
      : availability.why === 'traffic-off'
        ? 'GPT — catalogue off'
        : availability.why === 'catalogue-error'
          ? 'GPT — catalogue unreachable'
          : 'GPT — connecting…'
    const connectRow: ModelOption = {
      value: GPT_CONNECT_OPTION_VALUE,
      label,
      description: signIn
        ? `${connectToBrowseReason('openai')} — ↵ runs /logins`
        : availability.why === 'traffic-off'
          ? reason
          : `rows appear when the live catalogue lands (${reason}) — ↵ retries now`,
      descriptionForModel: signIn
        ? 'The GPT group is not connected — no catalogue is fetched while signed out; the operator signs in with /logins and the live catalogue then qualifies candidates.'
        : availability.why === 'traffic-off'
          ? `Catalogue traffic is switched off (${reason}); no model-list request is made and no GPT model can qualify until it is re-enabled.`
          : 'The GPT group is armed but not connected — the operator signs in with /logins; no GPT model is selectable until the live catalogue qualifies candidates.',
      group: OPENAI_MODEL_GROUP,
    }
    if (signIn) return [connectRow]
    return [connectRow, ...GPT_DISPLAY_PINS.map(pin => unavailableGptRow(pin, reason))]
  }
  const source =
    availability.sourceKind === 'chatgpt-subscription' ? 'ChatGPT subscription' : 'OpenAI API key'
  const out: ModelOption[] = []
  const listed = new Set<string>()
  for (const candidate of qualifiedGptCandidates('primary', availability.sourceKind)) {
    const id = candidate.identity.canonicalId
    listed.add(id)
    out.push({
      value: id,
      label: candidate.displayName,
      description: '',
      descriptionForModel: `${candidate.displayName} (${id}) — a GPT primary agent from the live catalogue on the native OpenAI Responses engine, billed to the connected ${source}.`,
      group: OPENAI_MODEL_GROUP,
    })
  }
  for (const pin of GPT_DISPLAY_PINS) {
    if (listed.has(pin.id)) continue
    const evaluated = evaluateGptCandidate(pin.id, availability.sourceKind)
    if (evaluated.ok) continue
    out.push(unavailableGptRow(pin, gptDisqualificationCopy(evaluated.why, source, pin)))
  }
  return out
}


export interface KeyLanePin {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
}

export interface KeyLaneReads {
  zaiKeyPresent(): boolean
  moonshotCredentialPresent(): boolean
  deepseekKeyPresent(): boolean
  compat(): { label: string; models: string[]; keyPresent: boolean } | undefined
}

function liveKeyLaneReads(): KeyLaneReads {
  return {
    zaiKeyPresent: () => {
      const { resolveZaiApiKey } =
        require('../router/providerDiscovery.js') as typeof import('../router/providerDiscovery.js')
      return resolveZaiApiKey() !== undefined
    },
    moonshotCredentialPresent: () => {
      const { resolveMoonshotAccount } =
        require('../../services/providers/moonshot/moonshotAccounts.js') as typeof import('../../services/providers/moonshot/moonshotAccounts.js')
      return resolveMoonshotAccount() !== undefined
    },
    deepseekKeyPresent: () => {
      const { resolveDeepseekApiKey } =
        require('../../services/providers/deepseek/deepseekAccounts.js') as typeof import('../../services/providers/deepseek/deepseekAccounts.js')
      return resolveDeepseekApiKey() !== undefined
    },
    compat: () => {
      const { resolveCompatSlotConfig, resolveCompatApiKey } =
        require('../../services/providers/openaicompat/compatAccounts.js') as typeof import('../../services/providers/openaicompat/compatAccounts.js')
      const config = resolveCompatSlotConfig()
      if (!config) return undefined
      return {
        label: config.label,
        models: config.models,
        keyPresent: resolveCompatApiKey() !== undefined,
      }
    },
  }
}

export function keyLanePins(provider: 'zai' | 'moonshot' | 'deepseek'): KeyLanePin[] {
  if (provider === 'zai') {
    const { GLM_STATIC_CATALOGUE } =
      require('../router/providers/zai.js') as typeof import('../router/providers/zai.js')
    return GLM_STATIC_CATALOGUE.map(entry => ({
      id: entry.id,
      displayName: entry.displayLabel,
      observedAt: '2026-08-21',
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    }))
  }
  if (provider === 'moonshot') {
    const { KIMI_DISPLAY_PINS } =
      require('../../services/providers/moonshot/kimiPins.js') as typeof import('../../services/providers/moonshot/kimiPins.js')
    return KIMI_DISPLAY_PINS.map(pin => ({
      id: pin.id,
      displayName: pin.displayName,
      observedAt: pin.observedAt,
      ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    }))
  }
  const { DEEPSEEK_DISPLAY_PINS } =
    require('../../services/providers/deepseek/deepseekPins.js') as typeof import('../../services/providers/deepseek/deepseekPins.js')
  return DEEPSEEK_DISPLAY_PINS.map(pin => ({
    id: pin.id,
    displayName: pin.displayName,
    observedAt: pin.observedAt,
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
  }))
}

export function keyLaneGroupRows(args: {
  group: string
  providerName: string
  connectValue: string
  connectHint: string
  connectLabel?: string
  keyPresent: boolean
  pins: KeyLanePin[]
}): ModelOption[] {
  if (args.keyPresent) {
    return args.pins.map(pin => ({
      value: pin.id,
      label: pin.displayName,
      description: '',
      descriptionForModel: `${pin.displayName} (${pin.id}) — ${args.providerName} model on the native chat-completions engine, billed to the attached API key. Catalogue facts observed ${pin.observedAt}; the provider's live answer governs.`,
      group: args.group,
      ...(pin.contextWindow !== undefined ? { statedContextWindow: pin.contextWindow } : {}),
    }))
  }
  return [
    {
      value: args.connectValue,
      label: `${args.providerName} — ${args.connectLabel ?? 'attach a key'}`,
      description: args.connectHint,
      descriptionForModel: `The ${args.providerName} group is visible but not credentialed — the operator attaches an API key (${args.connectHint}); no ${args.providerName} model is selectable until then.`,
      group: args.group,
    },
    ...args.pins.map(pin => ({
      value: pin.id,
      label: pin.displayName,
      description: '',
      descriptionForModel: `${pin.displayName} (${pin.id}) — in the ${args.providerName} lineup (observed ${pin.observedAt}) but NOT selectable: no API key attached.`,
      group: args.group,
      unavailable: 'no API key attached',
      ...(pin.contextWindow !== undefined ? { statedContextWindow: pin.contextWindow } : {}),
    })),
  ]
}

export function keyLaneProviderRows(reads: KeyLaneReads = liveKeyLaneReads()): ModelOption[] {
  const out: ModelOption[] = []
  out.push(
    ...keyLaneGroupRows({
      group: ZAI_MODEL_GROUP,
      providerName: 'Z.AI',
      connectValue: keyConnectValue('zai'),
      connectHint: '↵ opens /logins zai (a Z.AI API key — general or GLM Coding Plan) — ZAI_API_KEY works too',
      keyPresent: reads.zaiKeyPresent(),
      pins: keyLanePins('zai'),
    }),
  )
  out.push(
    ...keyLaneGroupRows({
      group: MOONSHOT_MODEL_GROUP,
      providerName: 'Moonshot',
      connectValue: keyConnectValue('moonshot'),
      connectHint: '↵ opens /logins moonshot (Kimi device-code sign-in, or a Moonshot API key) — MOONSHOT_API_KEY works too',
      connectLabel: 'sign in with Kimi or attach a key',
      keyPresent: reads.moonshotCredentialPresent(),
      pins: keyLanePins('moonshot'),
    }),
  )
  out.push(
    ...keyLaneGroupRows({
      group: DEEPSEEK_MODEL_GROUP,
      providerName: 'DeepSeek',
      connectValue: keyConnectValue('deepseek'),
      connectHint: '↵ opens /logins deepseek (a DeepSeek API key) — DEEPSEEK_API_KEY works too',
      keyPresent: reads.deepseekKeyPresent(),
      pins: keyLanePins('deepseek'),
    }),
  )
  const compat = reads.compat()
  if (compat === undefined) {
    out.push({
      value: keyConnectValue('compat'),
      label: 'Custom endpoint — configure',
      description: 'OpenAI-compatible slot (vLLM · LM Studio · Ollama · proxies) — MERCURY_COMPAT_BASE_URL configures it',
      descriptionForModel:
        'The OpenAI-compatible endpoint slot is unconfigured — the operator sets MERCURY_COMPAT_BASE_URL (plus MERCURY_COMPAT_MODELS / an optional key) to light it.',
      group: COMPAT_MODEL_GROUP,
    })
  } else if (compat.models.length === 0) {
    out.push({
      value: keyConnectValue('compat'),
      label: `${compat.label} — name models`,
      description:
        'endpoint configured, no models named — MERCURY_COMPAT_MODELS lists them (dispatch also accepts exact compat/<id>)',
      descriptionForModel: `The ${compat.label} endpoint is configured but names no models — the operator lists vendor ids via MERCURY_COMPAT_MODELS; exact compat/<id> spellings dispatch directly.`,
      group: COMPAT_MODEL_GROUP,
    })
  } else {
    for (const id of compat.models) {
      out.push({
        value: `compat/${id}`,
        label: id,
        description: '',
        descriptionForModel: `${id} — an operator-named model on the ${compat.label} OpenAI-compatible endpoint (${compat.keyPresent ? 'billed to the attached key' : 'auth-free endpoint'}).`,
        group: COMPAT_MODEL_GROUP,
      })
    }
  }
  return out
}

export function getModelOptions(reads: ModelOptionReads = {}): ModelOption[] {
  let options = baseTierRows()

  for (const id of ['claude-sonnet-5', 'claude-opus-5']) {
    const marketing = getMarketingNameForModel(id) ?? id
    pushIfAbsent(options, {
      value: id,
      label: marketing,
      description: '',
    })
  }

  options = dedupOneModelOneRow(options)

  const custom = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (custom) {
    pushIfAbsent(options, {
      value: custom,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || custom,
      description: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION || '',
    })
  }

  for (const cached of getGlobalConfig().additionalModelOptionsCache ?? []) {
    pushIfAbsent(options, cached)
  }

  for (const gpt of getQualifiedGptOptions()) {
    pushIfAbsent(options, gpt)
  }

  for (const row of getOpenrouterModelOptions()) {
    pushIfAbsent(options, row)
  }
  for (const row of getGeminiModelOptions()) {
    pushIfAbsent(options, row)
  }
  for (const row of getHuggingfaceModelOptions()) {
    pushIfAbsent(options, row)
  }
  for (const row of keyLaneProviderRows()) {
    pushIfAbsent(options, row)
  }
  for (const row of getLocalModelOptions()) {
    pushIfAbsent(options, row)
  }

  if (getSettings_DEPRECATED().availableModels !== undefined) {
    options = options.filter(opt => {
      if (opt.value === null) return true
      if (
        opt.value === GPT_CONNECT_OPTION_VALUE ||
        opt.value === OPENROUTER_CONNECT_OPTION_VALUE ||
        opt.value === GEMINI_CONNECT_OPTION_VALUE ||
        opt.value === HUGGINGFACE_CONNECT_OPTION_VALUE ||
        opt.value.startsWith(KEY_CONNECT_PREFIX)
      ) {
        return true
      }
      return isModelAllowed(opt.value)
    })
  }

  if (!(reads.anthropicCredentialed ?? liveAnthropicCredentialed)()) {
    const reason = anthropicNotSignedInReason()
    const decision = computedDefault()
    options = options.map(opt =>
      opt.group === undefined && opt.value === null
        ? decision.source === 'keyless'
          ? { ...opt, unavailable: NO_SIGN_IN_REASON }
          : opt
        : opt.group === undefined && typeof opt.value === 'string' && !isSentinelValue(opt.value)
          ? { ...opt, unavailable: reason }
          : opt,
    )
    options.unshift({
      value: ANTHROPIC_CONNECT_OPTION_VALUE,
      label: 'Claude — sign in',
      description: 'Claude subscription or Console API key — ↵ runs /logins anthropic',
      descriptionForModel:
        'The Anthropic group is visible but not credentialed — the operator signs in with /logins anthropic (or exports ANTHROPIC_API_KEY); no Anthropic model is selectable until then.',
    })
  }

  const SECTION_ORDER: readonly string[] = [
    OPENAI_MODEL_GROUP,
    OPENROUTER_MODEL_GROUP,
    GEMINI_MODEL_GROUP,
    HUGGINGFACE_MODEL_GROUP,
    ZAI_MODEL_GROUP,
    MOONSHOT_MODEL_GROUP,
    DEEPSEEK_MODEL_GROUP,
    COMPAT_MODEL_GROUP,
    LOCAL_MODEL_GROUP,
  ]
  const sectionRank = (opt: ModelOption): number => {
    if (opt.group === undefined) return 0
    const index = SECTION_ORDER.indexOf(opt.group)
    return index === -1 ? 0 : index + 1
  }
  options = SECTION_ORDER.map((_, i) => i + 1)
    .reduce(
      (acc, rank) => [...acc, ...options.filter(o => sectionRank(o) === rank)],
      options.filter(o => sectionRank(o) === 0),
    )

  return options
}

export function getDefaultOptionForUser(): ModelOption {
  return defaultRow()
}


function suffixedOption(alias: string, label: string, description: string): ModelOption {
  return { value: withContext1m(alias), label, description }
}

export function getOpus48_1MOption(): ModelOption {
  return suffixedOption('opus[1m]', 'Opus 4.8 (1M context)', '')
}
export function getOpus47_1MOption(): ModelOption {
  return suffixedOption('opus[1m]', 'Opus 4.7 (1M context)', '')
}
export function getSonnet46_1MOption(): ModelOption {
  return suffixedOption('sonnet[1m]', 'Sonnet 4.6 (1M context)', '')
}
export function getOpus46_1MOption(): ModelOption {
  return suffixedOption('opus[1m]', 'Opus 4.6 (1M context)', '')
}
export function getMaxSonnet46_1MOption(): ModelOption {
  return suffixedOption('sonnet[1m]', 'Sonnet 4.6 (1M context)', '')
}
export function getMaxOpus46_1MOption(): ModelOption {
  return suffixedOption('opus[1m]', 'Opus 4.6 (1M context)', '')
}


export function focusedOptionSupports1m(value: string | null): boolean {
  if (value === null) return false
  if (isCarrierShapedId(value)) return false

  const resolved = parseUserSpecifiedModel(stripContext1m(value))
  const canonical = getCanonicalName(resolved)
  if (canonical.includes('sonnet-5') || canonical.includes('opus-5')) {
    return false
  }
  const UNCONDITIONAL_1M = new Set(['claude-opus-4-6', 'claude-sonnet-4-6'])
  if (UNCONDITIONAL_1M.has(canonical)) return true
  if (canonical === 'claude-fable-5') return modelSupports1M(resolved)
  return false
}

void getBestModel
void getMarketingNameForModel
