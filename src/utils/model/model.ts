/**
 * The model-resolution core: setting precedence, alias parsing, family
 * defaults, canonicalization and display names.
 *
 * The invariant across this file is "project, never re-derive": the session
 * default projects the ONE computed default (owned by computedDefault.ts —
 * the newest usable row of the provider of the most recent sign-in), and
 * the first-party family's own rows project the ONE frontier decision
 * (frontierPolicy.ts, that family's gating); nothing here computes its own.
 */
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
import { SCRIBE_ROUTER_OPTION_VALUE, isScribeRouterSentinel } from '../scribeMode.js'

export type ModelShortName = string
export type ModelName = string
/** The persisted user setting: an alias/id string, or null (unset/default). */
export type ModelSetting = string | null

//
// Context-suffix helpers
//

// `[<n>m]` = the Anthropic 1M opt-in; `[served]` = the GPT served-window
// opt-down. Both are Mercury client-side
// annotations on the persisted model id — neither may ever reach the wire.
const CONTEXT_SUFFIX_RE = /\[(?:[0-9]+m|served)\]/gi
const TRAILING_1M_RE = /\[1m\]$/i

function hasContext1mSuffix(model: string): boolean {
  return TRAILING_1M_RE.test(model.trim())
}

/** Strip any `[1m]`/`[2m]`/`[served]` context annotation (global,
 *  case-insensitive). */
export function normalizeModelStringForAPI(model: string): string {
  return model.replace(CONTEXT_SUFFIX_RE, '')
}

//
// Family defaults — each is its own function; they do NOT share a shape
//

function firstPartyString(key: keyof typeof ALL_MODEL_CONFIGS): string {
  return getModelStrings()[key]
}

/** Large: env pin → the ratified static default (Opus 5). */
export function getDefaultOpusModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  if (pin) return pin
  return firstPartyString('opus5')
}

/** Mid: env pin → the ratified static default (Sonnet 5). */
export function getDefaultSonnetModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  if (pin) return pin
  return firstPartyString('sonnet5')
}

/** Small: env pin → haiku45 everywhere (no provider branch). */
export function getDefaultHaikuModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  if (pin) return pin
  return firstPartyString('haiku45')
}

/** Frontier: env pin → fable5 everywhere (no provider branch). */
export function getDefaultFableModel(): string {
  const pin = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (pin) return pin
  return firstPartyString('fable5')
}

/** Whether the frontier family is available — a projection of the one
 *  frontier decision. */
export function isFableAvailable(): boolean {
  return frontierOperatorDecision().source === 'frontier'
}

/** The FIRST-PARTY small/fast tier — the anthropic route's utility model
 *  (ANTHROPIC_SMALL_FAST_MODEL honoured before the small family default).
 *  It is one family's fact, not the session's: utility one-shots ride
 *  providerFrontier's sessionSmallFastModel/smallFastModelFor, which
 *  derive the tier from the SESSION's own family and answer this only on
 *  the anthropic route. */
export function getSmallFastModel(): string {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

//
// The default projections
//

/** `best` is the FIRST-PARTY frontier alias — it names that family's
 *  frontier decision, not the session default (the family aliases keep
 *  meaning each provider's family; the default is the computed thing). */
export function getBestModel(): string {
  return parseUserSpecifiedModel(frontierOperatorDecision().setting)
}

/** The session default SETTING: the ONE computed default — the newest
 *  usable row of the provider of the most recent sign-in (computedDefault.ts
 *  — the ledger, the picker's gating, the fallthrough, the keyless
 *  placeholder). Never re-derived here. */
export function getDefaultMainLoopModelSetting(): string {
  return computedDefault().setting
}

export function getDefaultMainLoopModel(): string {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

/** The provider display words, read at call time (routeLaw reads this
 *  module at load — the deferred-require idiom below). */
function providerNameOf(): (family: string) => string {
  const { providerDisplayName } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  return providerDisplayName
}

//
// Alias parsing
//

const RETIRED_LARGE_IDS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

/**
 * Parse a user setting to a concrete model ID. A trailing `[1m]` is a
 * context-window opt-in detached before matching and re-attached after.
 */
export function parseUserSpecifiedModel(input: string): string {
  return parseUserSpecifiedModelCore(input, true)
}

/** The alias/retired/pass-through core WITHOUT the catalogue fold rung —
 *  the fold module resolves row targets through this, so the fold can
 *  never re-enter itself (every catalogue row value is alias-or-declared
 *  by construction). Everyone else calls parseUserSpecifiedModel. */
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
      // The frontier family's second member by its exact-generation alias
      // (the sonnet5 / opus5 shape); the family alias keeps the default.
      return reattach(firstPartyString('fable51'))
    case 'mythos':
      // The frontier-mirror alias resolves to the table's mirror entry.
      return reattach(firstPartyString('mythos5'))
    case 'sonnet5':
      return reattach(firstPartyString('sonnet5'))
    case 'opus5':
      return reattach(firstPartyString('opus5'))
    case 'opusplan':
      // The plan alias resolves to the MID model (the large model only
      // applies in plan mode).
      return reattach(getDefaultSonnetModel())
    case 'best':
      // `best` resolves to the frontier decision and does NOT re-attach.
      return getBestModel()
    default:
      break
  }

  // Retired-large-ID remap. (No opt-out env knob —
  // the remap is unconditional.)
  if (RETIRED_LARGE_IDS.has(bare)) {
    return reattach(getDefaultOpusModel())
  }

  // The HUMAN-SPELLING fold (AGENTDIALS C2): a spelling NO rung above
  // matched and NO family declares — today's guaranteed-refusal class,
  // gated on recognizeModelId so every recognised id (declared family,
  // carrier shape, first-party mark/alias/env pin) passes through
  // byte-identical and the hot path pays nothing — matches
  // case/whitespace/hyphen/dot-insensitively against the CATALOGUE's ids
  // AND display names ("sonnet 5", "Sonnet-5", "gpt 5" resolve exactly
  // where "sonnet5" does; derived, provider-equal, no alias tables; exact
  // after the fold — an ambiguous fold refuses downstream per the route
  // law). Deferred require: a static import of the fold module would
  // cycle through modelOptions back into this file (the
  // auth/openaiCatalogue idiom below).
  if (catalogueFold && recognizeModelId(bare).kind === 'unrecognised') {
    try {
      const { resolveCatalogueSpelling } =
        require('./modelSpellingFold.js') as typeof import('./modelSpellingFold.js')
      const resolved = resolveCatalogueSpelling(bare)
      if (resolved !== null) return reattach(resolved)
    } catch {
      // An unreadable catalogue leaves the input as-is — the route law's
      // refusal downstream stays the honest answer.
    }
  }

  // Otherwise the input passes through with its ORIGINAL case preserved, only
  // the suffix normalised.
  return reattach(bare)
}

//
// The user-specified setting
//

/** Precedence: the bootstrap override slot (in-session + startup flag) →
 *  ANTHROPIC_MODEL → the saved setting; empty strings fall through. A
 *  router-sentinel value and an allowlist-forbidden value are ignored. */
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
  // A router-sentinel is a picker ACTION, not a model — a stuck persisted
  // sentinel self-heals to the default resolution.
  const specifiedModel = setting
  if (isScribeRouterSentinel(specifiedModel)) return null
  return specifiedModel
}

/** The main-loop model: the user setting parsed, or the computed default
 *  (which already orders every credentialed lane by sign-in recency and
 *  never lands on a row the credential cannot use). */
export function getMainLoopModel(): string {
  const setting = getUserSpecifiedModelSetting()
  const fromDefault = setting === null
  const resolved = fromDefault ? getDefaultMainLoopModel() : parseUserSpecifiedModel(setting)
  // A daemon-spawned worker (registered parent-PID flag) passes a DEFAULTED
  // resolution through the never-small-model floor — a default must not
  // drift small inside a worker. An EXPLICIT setting is the operator's own
  // word (every session runner is daemon-spawned, and a session runs the
  // model the operator chose — the economy tier included); the autonomous
  // teammate/crew spawns keep their own floors at their own doors.
  if (fromDefault && flagEnv('MERCURY_WORKER_PARENT_PID')) {
    return enforceSubagentModelFloor(resolved, 'daemon:worker-loop')
  }
  return resolved
}

//
// Runtime model (permission-mode aware)
//

export function getRuntimeMainLoopModel(params: {
  mainLoopModel: string
  permissionMode?: string
  exceeds200kTokens?: boolean
}): string {
  const { permissionMode } = params
  const setting = getUserSpecifiedModelSetting()
  const settingLower = (setting ?? '').trim().toLowerCase().replace(TRAILING_1M_RE, '')
  const isPlan = permissionMode === 'strategy'
  // The plan alias → the large model when the user setting is that alias, in
  // plan mode, and not past the 200k threshold.
  if (settingLower === 'opusplan' && isPlan && params.exceeds200kTokens !== true) {
    return getDefaultOpusModel()
  }
  // A small-model setting in plan mode → the mid model instead:
  // haiku has no plan-grade reasoning, so planning turns ride Sonnet.
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'strategy') {
    return getDefaultSonnetModel()
  }
  return params.mainLoopModel
}

/** True when the model is a first-party Opus that is not a custom string. */
export function isNonCustomOpusModel(model: string): boolean {
  return getCanonicalName(model).includes('opus')
}

//
// Canonicalization
//

/**
 * The PURE matcher (no override reversal). Returns the CANONICAL first-party
 * ID STRING (e.g. `claude-opus-4-6`), folding point releases onto an earlier
 * canonical while the frontier family keeps its own.
 */
function canonicalMatch(id: string): string {
  // 0. A carrier-shaped id — a reserved namespace ('openrouter/…',
  //    'compat/…') OR a bare vendor slug (any '/', e.g. the OpenRouter row
  //    anthropic/claude-opus-5 spelled without its carrier prefix) —
  //    carries the VENDOR's identity: it never substring-joins onto a
  //    first-party canonical (joining it would hand carrier rows
  //    first-party cost/effort/capability truth; no first-party id
  //    contains '/').
  if (isCarrierShapedId(id)) return id
  const lowered = id.toLowerCase()
  // 1. The current-generation ids are their own canonicals (no fold).
  if (lowered.includes('sonnet-5')) return 'claude-sonnet-5'
  if (lowered.includes('opus-5')) return 'claude-opus-5'
  // 2. Explicit family checks, most specific first. Claude Fable 5.1 keeps
  //    its own wire id (the Mythos 5.1 mirror folds onto it, as Mythos 5
  //    folds onto Fable 5) — checked BEFORE the fable-5 substring arm, which
  //    would otherwise swallow it.
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
  // 3. Older naming scheme families.
  if (lowered.includes('3-7-sonnet')) return 'claude-3-7-sonnet'
  if (lowered.includes('3-5-sonnet')) return 'claude-3-5-sonnet'
  if (lowered.includes('3-5-haiku')) return 'claude-3-5-haiku'
  // 4. Generic claude- prefix.
  const generic = lowered.match(/(claude-[a-z0-9-]+)/)
  if (generic) return generic[1]
  // 5. Otherwise the input.
  return id
}

/** The public canonicalizer reverses any settings override first. */
export function getCanonicalName(name: string): string {
  const normalized = normalizeModelStringForAPI(name)
  // Internal ant-model override reversal — inert in this build:
  // resolveAntModel always returns undefined, so the input passes through.
  const antResolved = resolveAntModel(normalized) ?? normalized
  return canonicalMatch(resolveOverriddenModel(antResolved))
}

export function firstPartyNameToCanonical(name: string): string {
  return canonicalMatch(normalizeModelStringForAPI(name))
}

//
// Display names
//

/** Keys whose display carries a `[1m]` twin: the shared 1M-support
 *  predicate's accept set. */
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

/** The provider-resolved-string → table key map for the active provider. */
function resolvedStringToKey(): Map<string, string> {
  const strings = getModelStrings()
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(strings)) map.set(value, key)
  return map
}

/** Exact-match display, then live catalog marketing name, then nothing. */
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
  // GPT engine ids: the official pin's display name, else the
  // parsed grammar's mechanical title — display material only (selectability
  // stays the live qualification owner's).
  const gpt = gptDisplayName(bare)
  if (gpt !== undefined) {
    return gpt
  }
  return null
}

/** The public display name, else the raw ID (honest fallback). */
export function renderModelName(model: string): string {
  return getPublicModelDisplayName(model) ?? model
}

/** Compact chip: friendly base name plus a verbatim ` [1m]` rider. */
export function renderModelChip(model: string): string {
  const base = getPublicModelDisplayName(normalizeModelStringForAPI(model))
  if (base === null) return model
  return hasContext1mSuffix(model) ? `${base} [1m]` : base
}

const CAPITALIZED_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'mythos', 'best'])

/** Capitalize only the first character (the shared helper's behaviour). */
function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

/** Render a setting: plan alias → its own label; any other alias →
 *  capitalized; otherwise the model-name renderer. */
export function renderModelSetting(setting: string): string {
  const lowered = setting.trim().toLowerCase().replace(TRAILING_1M_RE, '')
  if (lowered === 'opusplan') return 'Opus in strategy mode, else Sonnet'
  if (CAPITALIZED_ALIASES.has(lowered)) return capitalizeFirst(setting.trim())
  return renderModelName(setting)
}

/** Render the default setting: null renders the computed default's row
 *  (or 'no sign-in yet'). */
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

/** Commit-trailer author name: "Claude <display>" for known, "Claude
 *  (<raw>)" otherwise. */
export function getPublicModelName(model: string): string {
  const display = getPublicModelDisplayName(model)
  return display !== null ? `Claude ${display}` : `Claude (${model})`
}

/** The /model label for a session on the default: the row, the default
 *  word, the provider and the sign-in it came from (or the logins door). */
export function renderDefaultModelLabel(): string {
  return describeComputedDefaultLabel(computedDefault(), providerNameOf())
}

/** The model display string for a setting. */
export function modelDisplayString(setting: ModelSetting): string {
  if (setting === null) {
    return describeComputedDefaultRow(computedDefault(), providerNameOf())
  }
  const resolved = parseUserSpecifiedModel(setting)
  if (resolved === setting) return renderModelName(setting)
  return `${setting} (${renderModelName(resolved)})`
}

//
// Marketing name (a SEPARATE table from the display-name lookup)
//

const MARKETING_NAMES: Record<string, string> = {
  ...DISPLAY_NAMES,
  // The three claude-3-x entries take the long form here.
  sonnet37: 'Claude 3.7 Sonnet',
  sonnet35: 'Claude 3.5 Sonnet',
  haiku35: 'Claude 3.5 Haiku',
}

/** Marketing name for a model ID. Raw-ID checks precede canonical checks
 *  for point releases that fold onto another canonical. */
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
  // GPT engine ids — the pin/grammar display name; gpt ids never ride the
  // [1m] suffix (context is the official window).
  const gptName = gptDisplayName(bare)
  if (gptName !== undefined) {
    return gptName
  }
  return null
}

//
// Pricing / description projections
//

/** Whether the current large default is NATIVELY 1M (its bare id resolves a
 *  base window of at least 1M through the one window owner). */
export function isDefaultOpusNatively1M(): boolean {
  return getContextWindowForModel(normalizeModelStringForAPI(getDefaultOpusModel())) >= 1_000_000
}

/** Whether the Opus 1M merge is enabled (suffix-merge gate). */
export function isOpus1mMergeEnabled(): boolean {
  return false
}

export function isLegacyModelRemapEnabled(): boolean {
  // Always on: no opt-out env
  // exists.
  return true
}

/** The default-row description fragment — a projection of the one computed
 *  default, every account alike: the '(<name>)' part its consumer (the
 *  Status label) prefixes with its own 'Default' word — the neutral grammar
 *  with the row, the provider and the sign-in inside the
 *  parenthesis, and the logins door when no sign-in exists. The display
 *  owner renders a 1M note exactly once (the Status-card double-note bug
 *  class stays fixed by construction). */
export function getDefaultModelDescription(): string {
  return describeComputedDefaultRow(computedDefault(), providerNameOf()).slice('Default '.length)
}

/**
 * Skill model-override resolution: carry the [1m] suffix over only when
 * the current model has it, the skill's model does not, and the skill's
 * RESOLVED model actually supports 1M.
 */
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

