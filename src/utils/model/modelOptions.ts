/**
 * The `/model` picker option list per account tier, plus the toggle helpers
 * and dedup.
 *
 * An option is a value (a model setting or a sentinel), a label, a
 * description shown to the operator, and optionally a distinct description
 * written for the model.
 *
 * THE NEUTRALITY RULING (the operator's word): the catalog reads as one
 * even-handed list — no vendor's rows carry capability prose or tier
 * marketing. A MODEL row's description is EMPTY for every provider alike;
 * the facts ride typed fields (`statedContextWindow`, `unavailable`), the
 * label (names, the 1M-context twin note) and the group heading detail.
 * The description slot still speaks on rows that are not models: the
 * Default row states its resolution (`Default (<name>)` — the computed
 * default's row, provider and sign-in, or the logins door), action rows
 * state what ↵ does, MODES rows state their live seat derivation, and
 * operator-supplied copy (env/cache) passes through untouched.
 * prove-model-honesty §7 pins this grammar by predicate.
 */
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
  computedDefault,
  describeComputedDefaultRow,
  keylessReason,
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
  /** A distinct description written for the model, when it differs. */
  descriptionForModel?: string
  /** Picker group heading — provider distinction. Rows without one land in
   *  the Anthropic group (the default lane). */
  group?: string
  /** Present ⇔ the row is visible but NEVER selectable, with the honest
   *  reason (provider parity: availability is answered by the
   *  owning resolver — evaluateGptCandidate / the seat availability chain —
   *  never assumed in UI). Selection surfaces must refuse ↵ on these rows. */
  unavailable?: string
  /** The window the SOURCE states for this row (tokens) — carrier
   *  catalogues (OpenRouter, Hugging Face) whose ids the Anthropic window
   *  resolver cannot know. Absent = unknown: the picker paints NO column
   *  rather than a borrowed default. */
  statedContextWindow?: number
}

/** The GPT-connect sentinel (contract data). */
export const GPT_CONNECT_OPTION_VALUE = '__hermes_gpt_connect__'
/** The Anthropic sign-in sentinel (contract data): the group's ONE action
 *  row while no Anthropic credential exists — the grammar every other
 *  family's group carries. Shape-matched by isProviderActionRow; ↵ runs
 *  /logins anthropic. */
export const ANTHROPIC_CONNECT_OPTION_VALUE = '__mercury_anthropic_connect__'

/** Injectable reads for the composers that build over injected presences
 *  (the coordinator and sub-model registries, provers); production callers
 *  pass nothing. */
export interface ModelOptionReads {
  /** The Anthropic family's credential presence — providerFamilyPresences()'s
   *  own anthropic answer (providerUsage.anthropicCredentialPresence, the
   *  ONE owner /accounts, /config, /usage, the coordinator picker and the
   *  sub-model picker read). A composer that already holds the presence
   *  enumeration hands its answer down, so the catalogue's gate and the
   *  composer's own label are one fact, never two reads that can drift. */
  anthropicCredentialed?: () => boolean
}

/** The live presence read — required at call time: the usage facade reaches
 *  the provider snapshot, which reaches back into the catalogue modules. */
function liveAnthropicCredentialed(): boolean {
  const { anthropicCredentialPresence } =
    require('../../services/providers/providerUsage.js') as typeof import('../../services/providers/providerUsage.js')
  return anthropicCredentialPresence().credentialed
}

/** The Anthropic group's not-signed-in reason, spelled by the ONE attach-
 *  home owner (subModelSlots.subModelConnectHome) — the exact words the
 *  coordinator picker's label and the sub-model picker's rows paint. */
export function anthropicNotSignedInReason(): string {
  const { subModelConnectHome } =
    require('./subModelSlots.js') as typeof import('./subModelSlots.js')
  const home = subModelConnectHome('anthropic')
  return `not signed in — ${home.command ?? home.note}`
}

export { getGptSeatAvailability }
export type { GptSeatAvailability }

//
// Suffix helpers
//

const TRAILING_1M_RE = /\[1m\]$/i
const ANY_1M_RE = /\[1m\]/gi

/** Apply the suffix (idempotent, guarded by the shared predicate). */
export function withContext1m(value: string): string {
  if (TRAILING_1M_RE.test(value)) return value
  return `${value}[1m]`
}

/** Remove the suffix (global, case-insensitive). */
export function stripContext1m(value: string): string {
  return value.replace(ANY_1M_RE, '')
}

//
// The Default row
//

const DEFAULT_LABEL = 'Recommended'

function defaultRow(): ModelOption {
  // One naming grammar for every account: 'Default (<name>)' — the name
  // carries the row the computed default resolved, its provider and the
  // sign-in it came from (the newest usable row of the provider of the
  // most recent sign-in), or the logins door when no sign-in exists.
  const { providerDisplayName } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  return {
    value: null,
    label: DEFAULT_LABEL,
    description: describeComputedDefaultRow(computedDefault(), providerDisplayName),
  }
}

//
// Tier lists: the base list branches on account tier — premium
// subscribers, standard subscribers, and pay-as-you-go. Row display derives
// from what a value actually resolves to, never from hardcoded version
// literals.
//

function aliasRow(alias: string, description: string): ModelOption {
  return { value: alias, label: renderModelName(parseUserSpecifiedModel(alias)), description }
}

/** A literal-valued row (previous-generation rows). */
function literalRow(id: string, description: string): ModelOption {
  return { value: id, label: renderModelName(id), description }
}

/** The frontier row (Fable) — an ordinary catalogue row on every tier
 *  (operator ruling: Fable 5 is a normal catalogue row; the
 *  allowlist treats it like every model). The frontier decision decides
 *  only which model the Default row carries. */
function getFableOption(): ModelOption {
  return {
    value: 'fable',
    label: renderModelName(parseUserSpecifiedModel('fable')),
    description: '',
  }
}

/** The frontier family's newer member, Claude Fable 5.1 — a literal row
 *  beside the family alias row under the same neutrality ruling (no
 *  description). The alias row keeps carrying the family default; this row
 *  never moves it. Bare id only: 1M is its default and maximum, so no [1m]
 *  twin and no context toggle. */
function getFable51Option(): ModelOption {
  return literalRow(getModelStrings().fable51, '')
}

/** The explicit large-model fallback row, so Opus stays an immediately-
 *  available choice once the Default row follows the frontier decision. */
function getOpusFrontierFallbackOption(): ModelOption {
  return {
    value: 'opus',
    label: renderModelName(parseUserSpecifiedModel('opus')),
    description: '',
  }
}

/** The suffixed mid row, only while the mid default still carries 1M via the
 *  suffix (a natively-1M catalog default serves 1M on the bare alias). */
function suffixedMidRow(): ModelOption | null {
  if (has1mContext(getDefaultSonnetModel())) return null
  if (!checkSonnet1mAccess()) return null
  return aliasRow('sonnet[1m]', '')
}

/** The previous generations of the large family (table keys, newest first). */
const PREVIOUS_LARGE_KEYS = ['opus48', 'opus47', 'opus46'] as const

/**
 * Explicit previous-generation large rows and their suffixed twins, gated on
 * 1M access. Values are the provider-resolved literal IDs; the entry equal to
 * the CURRENT large default is skipped (it is not "previous-generation", and
 * a literal twin of the alias row would trip the one-model-one-row dedup).
 */
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

/** The one-of-three large-model shape (standard subscribers + first-party
 *  pay-as-you-go): one row when natively 1M, a merged suffixed row when the
 *  merge gate is on, else a bare row plus a suffixed row gated on access. */
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

/** Premium subscribers (list 1). */
function premiumSubscriberTierRows(): ModelOption[] {
  const rows: ModelOption[] = [defaultRow()]
  // The frontier row rides every tier; the explicit large fallback joins
  // when the frontier lane wins (the Default row does not carry the large
  // model then).
  rows.push(getFableOption())
  rows.push(getFable51Option())
  if (isFableAvailable()) {
    rows.push(getOpusFrontierFallbackOption())
  }
  // A suffixed large row when the large default is neither natively 1M nor
  // suffix-merged and 1M access exists.
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

/** Standard subscribers (list 2); the same shape serves first-party
 *  pay-as-you-go (list 3). */
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

/** The base list, branched on account tier: the premium arm fires for Max
 *  AND team-premium accounts; every other account (standard subscribers and
 *  pay-as-you-go alike) takes the standard shape. */
function baseTierRows(): ModelOption[] {
  return isClaudeAISubscriber() && (isMaxSubscriber() || isTeamPremiumSubscriber())
    ? premiumSubscriberTierRows()
    : standardShapeTierRows()
}

//
// Assembly
//

function collectStringValues(options: ModelOption[]): Set<string> {
  const values = new Set<string>()
  for (const option of options) {
    if (typeof option.value === 'string') values.add(option.value)
  }
  return values
}

function isSentinelValue(v: string): boolean {
  // The GPT connect action row is a picker ACTION, never a model — it must
  // not enter alias/identity resolution (dedup, 1m toggling, allowlists).
  if (v === GPT_CONNECT_OPTION_VALUE) return true
  return v.startsWith('__') || v.includes(':')
}

/** Resolve a value string to its concrete model id (suffix preserved). */
function resolveWithSuffix(value: string): string {
  const suffix = TRAILING_1M_RE.test(value) ? '[1m]' : ''
  const resolved = parseUserSpecifiedModel(stripContext1m(value))
  return TRAILING_1M_RE.test(resolved) ? resolved : `${resolved}${suffix}`
}

/**
 * Does `candidate` (a literal model setting) resolve to the same model as one
 * of the existing option rows? Sentinel values are never resolved. Drives
 * the picker's resolved-identity dedup and step-3 "one model, one row".
 */
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

/** Step 3 "one model, one row": drop an alias-valued row whose resolved model
 *  also appears as another row's value; the explicit row wins. */
function dedupOneModelOneRow(options: ModelOption[]): ModelOption[] {
  const collected = collectStringValues(options)
  return options.filter(option => {
    const value = option.value
    if (typeof value !== 'string' || isSentinelValue(value)) return true
    const bare = stripContext1m(value)
    const resolved = parseUserSpecifiedModel(bare)
    if (resolved === bare) return true // resolves to itself → kept
    return !collected.has(resolved)
  })
}

function pushIfAbsent(options: ModelOption[], row: ModelOption): void {
  if (row.value !== null && options.some(existing => existing.value === row.value)) return
  options.push(row)
}

/** The picker group headings (operator ruling: provider sections
 *  first; provider-08-21 adds the
 *  four engine groups — a provider with ANY state is VISIBLE, never hidden).
 *  Rows without a group land in the Anthropic section (the default lane);
 *  ANTHROPIC_MODEL_GROUP is that section's one heading spelling for the
 *  wrappers that paint it. */
export const ANTHROPIC_MODEL_GROUP = 'Mercury — Anthropic models'
export const OPENAI_MODEL_GROUP = 'Mercury — OpenAI models'
export const ZAI_MODEL_GROUP = 'Mercury — Z.AI models'
export const MOONSHOT_MODEL_GROUP = 'Mercury — Moonshot models'
export const DEEPSEEK_MODEL_GROUP = 'Mercury — DeepSeek models'
export const COMPAT_MODEL_GROUP = 'Mercury — custom endpoint'

/** The key-lane connect sentinels (picker ACTIONS, never models): ↵ routes
 *  to the lane's /logins row (/logins <provider>) — the GPT
 *  connect row's grammar for API-key providers. */
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

/** A picker ACTION row (connect/attach sentinels) — surfaces skip the model
 *  columns for these (the GPT connect row's treatment). */
export function isProviderActionRow(value: string): boolean {
  return (
    value === GPT_CONNECT_OPTION_VALUE ||
    value.startsWith(KEY_CONNECT_PREFIX) ||
    // The auth-lane connect sentinels ('__mercury_<provider>_connect__') —
    // shape-matched here because their owning catalogue modules import this
    // file (a literal import would cycle).
    /^__mercury_[a-z0-9-]+_connect__$/.test(value)
  )
}

/**
 * the GPT rows for the /model picker — since the provider-
 * parity ruling the FULL current OpenAI lineup, not only the
 * qualified ids. Selectability law (decision #6 / brief): engines armed +
 * an OpenAI account source + LIVE-catalogue qualification (served, visible,
 * effort catalogue decodes — the era generation floor is absent). Lineup members the
 * resolver disqualifies render VISIBLE-BUT-UNAVAILABLE (`unavailable`
 * carries the typed reason's honest copy) and are never selectable —
 * availability is always evaluateGptCandidate's / the seat chain's answer,
 * never assumed here. Sync over the bounded cache; getGptSeatAvailability
 * kicks the TTL'd single-flight refresh for the pending/failed states.
 *
 * The always-visible-group law (field directive; engines are
 * default-on since): the GPT group never silently vanishes — every not-ready state
 * projects the ONE action row whose ↵ the picker routes by the typed `why`
 * (sign-in states run /logins; catalogue states retry the fetch), followed by
 * the lineup as unavailable rows so the catalogue stays visible. The label
 * never claims "connecting…" for a terminal state: a failed fetch and an
 * expired sign-in name themselves.
 */
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
      // Factual reason only — the verdict-word removal ruled every
      // qualification word off every model row.
      return 'effort catalogue undecodable'
    case 'catalogue-unavailable':
      return `live catalogue unavailable${why.detail ? ` (${why.detail})` : ''}`
    case 'account-source-unavailable':
    case 'not-gpt-family':
    case 'unparseable-id':
      return 'not offered here'
  }
}

/** One visible-but-unavailable lineup row (never selectable — the picker
 *  refuses ↵; the reason rides the row copy). */
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
    // Signed out, the honest face is the ONE connect row (the
    // catalogue-gating law): no request happens, and no bundled lineup
    // renders where a browsable catalogue would sit. Credentialed
    // pending/error/dark states keep the lineup visible-but-unavailable
    // (the catalogue is a fact about the provider; selectability a fact
    // about the account).
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
  // The rest of the current lineup: visible, never selectable, each carrying
  // the RESOLVER's disqualification (never a UI guess).
  for (const pin of GPT_DISPLAY_PINS) {
    if (listed.has(pin.id)) continue
    const evaluated = evaluateGptCandidate(pin.id, availability.sourceKind)
    if (evaluated.ok) continue // qualified ⇒ already listed from the live walk
    out.push(unavailableGptRow(pin, gptDisqualificationCopy(evaluated.why, source, pin)))
  }
  return out
}

//
// The key-lane provider groups — one grammar for
// every API-key engine family, mirroring the GPT group's laws: credentialed ⇒
// the catalogue rows selectable (each pin a dated observation); absent ⇒ ONE
// attach-a-key action row (↵ routes /logins <provider>) followed by the
// lineup as visible-but-unavailable rows — the catalogue is a fact about the
// provider, selectability a fact about the credential; NEVER a hidden group.
// Pure over injected reads so the picker-honesty prover pins every state.
//

export interface KeyLanePin {
  id: string
  displayName: string
  observedAt: string
  /** The window the lane's own pin record states (tokens) — absent where
   *  the official pages state none (absent beats invented). */
  contextWindow?: number
}

export interface KeyLaneReads {
  zaiKeyPresent(): boolean
  /** A Kimi sign-in OR a Moonshot key — the family's owning account read. */
  moonshotCredentialPresent(): boolean
  deepseekKeyPresent(): boolean
  /** undefined = the slot is unconfigured (no base URL). */
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

/** The key-lane pin tables, flagship-first (each lane's own last-observed
 *  record) — exported as the ONE read seam for pin-derived facts (the
 *  provider-frontier recommendation reads the same rows the picker paints). */
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

/** One key-lane group's rows (exported pure for the picker-honesty prover). */
export function keyLaneGroupRows(args: {
  group: string
  providerName: string
  connectValue: string
  connectHint: string
  /** The action row's verb — 'attach a key' unless the family also signs in. */
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

/** Every key-lane provider group, in the stable provider order. */
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
    // Unconfigured slot: one visible action row naming the config route —
    // the group never silently vanishes (the always-visible-group law).
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

  // 1. The current-generation explicit rows: the hand registry's newest
  //    ids, listed explicitly so the alias tier rows above dedup onto them
  //    (the explicit row wins "one model, one row").
  for (const id of ['claude-sonnet-5', 'claude-opus-5']) {
    const marketing = getMarketingNameForModel(id) ?? id
    pushIfAbsent(options, {
      value: id,
      label: marketing,
      description: '',
    })
  }

  // 3. One model, one row.
  options = dedupOneModelOneRow(options)

  // 6. A custom model row from the env option. The description is the
  //    OPERATOR's own copy (env passthrough) — Mercury authors none.
  const custom = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (custom) {
    pushIfAbsent(options, {
      value: custom,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || custom,
      description: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION || '',
    })
  }

  // 7. Additional model options previously cached in global config.
  for (const cached of getGlobalConfig().additionalModelOptionsCache ?? []) {
    pushIfAbsent(options, cached)
  }

  // 8. The OpenAI lane — its own picker group, appended after the Anthropic
  //    rows and router modes so the provider heading paints exactly once.
  for (const gpt of getQualifiedGptOptions()) {
    pushIfAbsent(options, gpt)
  }

  // 8b. The provider catalogs — one group grammar:
  //     live-derived rows; credentialed ⇒ selectable; absent ⇒ an honest
  //     connect/attach action row; lineups visible-but-unavailable while a
  //     dispatch wire or credential is pending (the owning catalogue module
  //     answers, never this file). OpenRouter · Gemini · Z.AI · Moonshot ·
  //     DeepSeek · the operator-named compat slot.
  for (const row of getOpenrouterModelOptions()) {
    pushIfAbsent(options, row)
  }
  for (const row of getGeminiModelOptions()) {
    pushIfAbsent(options, row)
  }
  // The Hugging Face router (live catalogue; dated pins stand in) and the
  // locally served models (discovery only — an empty probe is an absent
  // group, never a phantom row).
  for (const row of getHuggingfaceModelOptions()) {
    pushIfAbsent(options, row)
  }
  for (const row of keyLaneProviderRows()) {
    pushIfAbsent(options, row)
  }
  for (const row of getLocalModelOptions()) {
    pushIfAbsent(options, row)
  }

  // 9. Allowlist filter — the Default row and the provider connect/attach
  //    action rows exempt (action rows are actions, not models).
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

  // 9b. The Anthropic group's credential gate — the law every other family's
  //     group already carries (credentialed ⇒ selectable; absent ⇒ ONE
  //     sign-in action row and the lineup visible-but-unavailable), read
  //     from the ONE presence owner. The Default row resolves to the
  //     Anthropic default, so it is gated with its family; the action row
  //     rides first in the section and ↵ on it runs /logins anthropic. The
  //     group never hides (the always-visible-group law) — the catalogue is
  //     a fact about the provider, selectability a fact about the credential.
  if (!(reads.anthropicCredentialed ?? liveAnthropicCredentialed)()) {
    const reason = anthropicNotSignedInReason()
    // The Default row follows the COMPUTED default: it is gated only while
    // it resolves to no usable row (the neutral words, never this family's
    // — the logins door with no sign-in anywhere, each sign-in's own gate
    // when sign-ins exist) — a default that landed on another signed-in
    // family stays selectable whatever this family's credential state.
    const decision = computedDefault()
    options = options.map(opt =>
      opt.group === undefined && opt.value === null
        ? decision.source === 'keyless'
          ? { ...opt, unavailable: keylessReason(decision) }
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

  // 10. Stable section partition (provider sections
  // stable): Anthropic rows first, then each provider
  //     catalog in the stable order (OpenAI · OpenRouter · Gemini · Z.AI ·
  //     Moonshot · DeepSeek · the compat slot), the composite MODES last —
  //     each picker heading paints exactly once, insertion order preserved
  //     within a section.
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

//
// Named 1M option builders (used by the picker's direct rows)
//

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

//
// The 1M toggle predicate
//

/** Whether the focused option offers an in-place context toggle. */
export function focusedOptionSupports1m(value: string | null): boolean {
  if (value === null) return false
  // Carrier-shaped rows (openrouter/… · compat/… · huggingface/… ·
  // local/… · any bare vendor slug) never offer Mercury's context toggle:
  // the vendor's slug is the whole identity, and a [1m] pressed onto it
  // becomes display dressing inside the persisted id — the exact junk the
  // wire owner refuses (the live OpenRouter 400).
  if (isCarrierShapedId(value)) return false

  const resolved = parseUserSpecifiedModel(stripContext1m(value))
  const canonical = getCanonicalName(resolved)
  // Natively-1M ids (base window already 1M) never offer the toggle —
  // offering "200k → 1M" on a natively-1M model would lie.
  if (canonical.includes('sonnet-5') || canonical.includes('opus-5')) {
    return false
  }
  // The three newest large canonicals and the mid-4 canonical: UNCONDITIONAL
  // yes (no capability/billing check; the kill switch does not suppress them).
  const UNCONDITIONAL_1M = new Set(['claude-opus-4-6', 'claude-sonnet-4-6'])
  if (UNCONDITIONAL_1M.has(canonical)) return true
  // The frontier canonical: gated on the shared 1M-support predicate.
  if (canonical === 'claude-fable-5') return modelSupports1M(resolved)
  return false
}

void getBestModel
void getMarketingNameForModel
