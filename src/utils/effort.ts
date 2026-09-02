import type { EffortLevel } from '../entrypoints/sdk/runtimeTypes.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { nearestSupportedWireEffort } from '../services/providers/openai/gptPins.js'
import { isGlmModelId } from '../services/providers/zai/glmPins.js'
import { isEnterpriseSubscriber, isMaxSubscriber, isProSubscriber, isTeamSubscriber } from './auth.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import {
  effortVocabularyFor,
  getMaxSupportedEffortLevel,
  gptEffortVocabularyView,
  gptModelDefaultEffort,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from './model/capabilities.js'
import { resolveAntModel } from './model/antModels.js'
import { getInitialSettings, getSettingsForSource } from './settings/settings.js'
import { isDeepthinkEnabled, sessionThinkingEnabled } from './thinking.js'

/**
 * The single effort-resolution owner: parsing, persistence, launch pins,
 * defaults, provider vocabulary, and display truth. No other surface may
 * work out any part of the answer for itself. The invariant throughout is
 * that the displayed value equals the dispatched value.
 */

export type { EffortLevel }
export type EffortValue = EffortLevel | number

/** The five ordered levels; the strings appear in settings, flags and wires. */
// prettier-ignore
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as readonly EffortLevel[]

export { modelSupportsEffort, modelSupportsMaxEffort, modelSupportsXHighEffort, getMaxSupportedEffortLevel }

// The first-party documented default word when no parameter is sent.
const FIRST_PARTY_DEFAULT_LEVEL: EffortLevel = 'high'
// The explicit word when an external wire omits the key.
const EXTERNAL_DEFAULT_LABEL = 'default'
/** The one word for honest absence: a model that takes no effort setting
 *  labels itself so on every surface — never a borrowed tier word (the
 *  first-party default 'high' used to stand in for Hugging Face, the
 *  compat slot and every other no-dial id). */
export const NO_EFFORT_CONTROL_LABEL = 'no effort control'

// Keyed by the COLLAPSED spelling (separators removed, the word 'effort'
// stripped) — see normalizeEffortLevelString, the one normalizer every
// wordy intake resolves through.
const ALIASES: Record<string, EffortLevel> = {
  med: 'medium',
  maximum: 'max',
  extrahigh: 'xhigh',
}

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v)
}

export function isValidNumericEffort(v: number): boolean {
  return Number.isInteger(v)
}

/**
 * The general parser: undefined/null/'' → undefined; an integer number →
 * itself; else stringify, trim, lowercase, alias-map, and accept a level;
 * else the lenient integer prefix. A non-integer number stringifies and
 * parses leniently to its integer prefix.
 */
export function parseEffortValue(v: unknown): EffortValue | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number' && isValidNumericEffort(v)) return v
  const text = String(v).trim().toLowerCase()
  const level = normalizeEffortLevelString(text)
  if (level !== undefined) return level
  const numeric = parseInt(text, 10)
  return isValidNumericEffort(numeric) ? numeric : undefined
}

/**
 * THE ONE NORMALIZER for wordy effort intake — the effort command, the model
 * picker, the CLI flag, the daemon's dispatch/verb doors and the concourse
 * coordinator's launch tool all resolve spoken spellings through here (the
 * parseUserSpecifiedModel exact-spellings law, applied to effort words).
 * An operator's plain spelling and the ladder word are the same request:
 * separators collapse and the word 'effort' contributes nothing, so
 * 'max effort', 'x high', 'x-high', 'extra high' and 'maximum' resolve to
 * their ladder tiers. Anything else is undefined — callers refuse TYPED,
 * naming the ladder; nothing off-ladder is ever silently substituted.
 */
export function normalizeEffortLevelString(input: string): EffortLevel | undefined {
  const worded = input.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  const collapsed = worded.replace(/\beffort\b/g, '').replace(/\s+/g, '')
  const level = ALIASES[collapsed] ?? collapsed
  return isEffortLevel(level) ? level : undefined
}

/**
 * The --effort door's parser: a ladder word (plain spellings and aliases
 * through the one normalizer) or a typed REFUSAL sentence. The door refuses
 * — commander exits 1 on the sentence — so the sentence says the value is
 * not on the ladder and names the ladder; it never claims the run went
 * ahead on a default (the old text did, while the run stopped). The
 * sentence is the one the flag door prints (main.tsx spells the same
 * literal, pinned by the wave-6 field prover).
 */
export function parseCliEffort(input: string): { level: EffortLevel; refusal?: undefined } | { level: undefined; refusal: string } {
  const level = normalizeEffortLevelString(input)
  if (level) return { level }
  return {
    level: undefined,
    refusal: `Unrecognised effort level "${input}". Valid values: ${EFFORT_LEVELS.join(', ')}.`,
  }
}

/** Only the five levels persist; numeric and garbage values never write. */
export function toPersistableEffort(v: EffortValue | undefined): EffortLevel | undefined {
  return typeof v === 'string' && isEffortLevel(v) ? v : undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  return toPersistableEffort(getInitialSettings().effortLevel as EffortValue | undefined)
}

export function getInitialSupercodeSetting(): boolean {
  return getInitialSettings().supercodeEffort === true
}

/**
 * What, if anything, to write when the user picks a model in the picker:
 * the choice is explicit when a prior persisted value exists or the control
 * was touched; write the pick when explicit or when it differs from the
 * model default. A default-shaped pick writes nothing and so keeps following
 * future default changes.
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel | undefined,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const explicit = priorPersisted !== undefined || toggledInPicker
  if (explicit || picked !== modelDefault) return picked
  return undefined
}

/**
 * The env override; `unset`/`auto` (case-insensitive, compared WITHOUT
 * trimming) mean null — an explicit request to defer to the model or
 * provider default. Outranks every other source on every provider. A value
 * off the ladder is IGNORED (the session resolves as if the variable were
 * unset) — the boot prints describeEffortEnvOverride's sentence so the
 * ignoring is never silent.
 */
export function getEffortEnvOverride(): EffortLevel | null | undefined {
  return describeEffortEnvOverride().override
}

export type EffortEnvOverrideView =
  | { state: 'absent'; override: undefined }
  | { state: 'deferred'; raw: string; override: null }
  | { state: 'level'; raw: string; override: EffortLevel }
  | { state: 'ignored'; raw: string; override: undefined; sentence: string }

/**
 * The env door, described: the two doors that take an effort word — the
 * --effort flag and MERCURY_EFFORT_LEVEL — speak ONE vocabulary (the ladder
 * through the one normalizer). The flag REFUSES a word off the ladder; the
 * env door IGNORES it, and the `sentence` says exactly that, at boot, on
 * the surface the boot owns. An integer is off the ladder on both doors:
 * no provider wire encodes one, so accepting it here while the flag
 * refused it was one dial with two vocabularies.
 */
export function describeEffortEnvOverride(env: NodeJS.ProcessEnv = process.env): EffortEnvOverrideView {
  const raw = env.MERCURY_EFFORT_LEVEL
  if (raw === undefined) return { state: 'absent', override: undefined }
  const lowered = raw.toLowerCase()
  if (lowered === 'unset' || lowered === 'auto') return { state: 'deferred', raw, override: null }
  const level = normalizeEffortLevelString(raw)
  if (level !== undefined) return { state: 'level', raw, override: level }
  return {
    state: 'ignored',
    raw,
    override: undefined,
    sentence: `MERCURY_EFFORT_LEVEL='${raw}' is not on the effort ladder and is ignored — effort resolves as if it were unset. Valid values: ${EFFORT_LEVELS.join(', ')}; unset or auto defers to the model default.`,
  }
}

export type EffortCatalogueState =
  | 'static-tables'
  | 'gpt-live'
  | 'gpt-known-empty'
  | 'gpt-unstated'
  | 'gpt-unavailable'
  | 'documented-vocabulary'

export type EffortResolution = {
  readonly model: string
  readonly catalogue: EffortCatalogueState
  readonly requested: EffortValue | undefined
  readonly requestedSource: 'env' | 'env-suppressed' | 'session' | 'none'
  readonly supportsEffort: boolean
  readonly selectable: readonly EffortLevel[]
  readonly appliedValue: EffortValue | undefined
  readonly applied: EffortLevel | undefined
  readonly wire: string | undefined
  readonly label: string
  readonly adjustedFrom?: EffortLevel
  readonly providerVocabulary?: readonly string[]
  readonly providerDefault?: string
  /** Present when a lane whose effort dial is its reasoning dial sends no
   *  dial because the session's thinking is off — the provider default
   *  applies and the label says 'default'; the request stays intent. */
  readonly suppressedBy?: 'thinking-off'
}

/** The context a surface can hand the resolution: whether the call it
 *  speaks about thinks. The foreground session's answer is the boot-noted
 *  thinking config (sessionThinkingEnabled); a caller that runs its own
 *  call with thinking off — the concourse coordinator — says so, and the
 *  thinking-gated lanes then resolve to no dial exactly as their builders
 *  do. */
export type EffortTruthContext = {
  readonly thinkingEnabled?: boolean
}

/** Ladder-domain selectable stops: the first-party family's own vocabulary
 *  (xhigh and max only when served); empty off the ladder. */
export function selectableEffortLevelsForLadder(model: string): readonly EffortLevel[] {
  const view = effortVocabularyFor(model)
  return view.kind === 'ladder' ? view.vocabulary : []
}

/**
 * Step-down rules for the ladder domain: a max request steps to xhigh
 * when served, else high; an xhigh request steps to high. Never step past
 * a supported intermediate tier — an unserved tier comes back as a request
 * error, and once the value changes the printed word must change with it.
 */
function stepDown(model: string, value: EffortValue): EffortValue {
  if (typeof value !== 'string') return value
  if (value === 'max' && !modelSupportsMaxEffort(model)) {
    return modelSupportsXHighEffort(model) ? 'xhigh' : 'high'
  }
  if (value === 'xhigh' && !modelSupportsXHighEffort(model)) {
    return 'high'
  }
  return value
}

/** The frozen resolution record for a model plus the session-level value. */
export function resolveEffortTruth(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  context: EffortTruthContext = {},
): EffortResolution {
  return resolveEffortTruthWithEnv(model, appStateEffortValue, getEffortEnvOverride(), context)
}

/**
 * The truth for ANOTHER session's stamped tier — the same resolution, with
 * THIS process's env override deliberately absent. A launch receipt or a
 * seat row speaks about a session whose env pin is its own; letting the
 * speaking process's MERCURY_EFFORT_LEVEL leak into the sentence would
 * misreport the very session it names.
 */
export function resolveStampedEffortTruth(
  model: string,
  stamped: EffortValue | undefined,
  context: EffortTruthContext = {},
): EffortResolution {
  return resolveEffortTruthWithEnv(model, stamped, undefined, context)
}

function resolveEffortTruthWithEnv(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  envOverride: EffortValue | null | undefined,
  context: EffortTruthContext,
): EffortResolution {
  // The ant-model override resolution is inert in this build; the call site
  // stays (folded — no user-type gate) so the seam survives, and the inert
  // result is deliberately not consumed.
  resolveAntModel(model)
  const freeze = (record: EffortResolution): EffortResolution => Object.freeze(record)

  const requestedSource: EffortResolution['requestedSource'] =
    envOverride === null
      ? 'env-suppressed'
      : envOverride !== undefined
        ? 'env'
        : appStateEffortValue !== undefined
          ? 'session'
          : 'none'

  // Branch 1: the external reasoning provider.
  const gptView = gptEffortVocabularyView(model)
  if (gptView.state !== 'not-gpt') {
    const rawRequest =
      envOverride === null ? undefined : envOverride !== undefined ? envOverride : appStateEffortValue
    const request = typeof rawRequest === 'string' ? rawRequest : undefined
    const adjustedFrom = request !== undefined && isEffortLevel(request) ? request : undefined

    if (gptView.state === 'live') {
      const vocabulary = gptView.vocabulary
      const fallback =
        gptView.defaultEffort ??
        (vocabulary.includes('high') ? 'high' : vocabulary[0]) ??
        undefined
      let wire: string | undefined
      if (request === undefined) {
        wire = fallback
      } else if (vocabulary.includes(request)) {
        wire = request
      } else {
        wire = nearestSupportedWireEffort(request, vocabulary) ?? fallback
      }
      const applied = wire !== undefined && isEffortLevel(wire) ? wire : undefined
      return freeze({
        model,
        catalogue: 'gpt-live',
        requested: request,
        requestedSource,
        supportsEffort: true,
        selectable: EFFORT_LEVELS.filter(level => vocabulary.includes(level)),
        appliedValue: applied,
        applied,
        wire,
        label: wire ?? EXTERNAL_DEFAULT_LABEL,
        ...(adjustedFrom !== undefined && adjustedFrom !== wire ? { adjustedFrom } : {}),
        providerVocabulary: vocabulary,
        ...(gptView.defaultEffort !== undefined ? { providerDefault: gptView.defaultEffort } : {}),
      })
    }
    if (gptView.state === 'known-empty') {
      // A stated-empty vocabulary IS the live truth: no effort control, the
      // one absence word (the wire omits the key — the reasoning profile's
      // empty-vocabulary law).
      return freeze({
        model,
        catalogue: 'gpt-known-empty',
        requested: request,
        requestedSource,
        supportsEffort: false,
        selectable: [],
        appliedValue: undefined,
        applied: undefined,
        wire: undefined,
        label: NO_EFFORT_CONTROL_LABEL,
        ...(adjustedFrom !== undefined ? { adjustedFrom } : {}),
        providerVocabulary: [],
        ...(gptView.defaultEffort !== undefined ? { providerDefault: gptView.defaultEffort } : {}),
      })
    }
    // Unstated or unreachable: effort is reported as supported (the full
    // ladder is OFFERED — dispatch re-validates live and names adjustments)
    // but the wire omits the key; the provider-vocabulary field stays absent
    // — nothing is fabricated. (The per-generation max-cap here died with
    // the generation floor, it restated a dated observation.)
    return freeze({
      model,
      catalogue: gptView.state === 'unstated' ? 'gpt-unstated' : 'gpt-unavailable',
      requested: request,
      requestedSource,
      supportsEffort: true,
      selectable: EFFORT_LEVELS,
      appliedValue: undefined,
      applied: undefined,
      wire: undefined,
      label: EXTERNAL_DEFAULT_LABEL,
      ...(adjustedFrom !== undefined ? { adjustedFrom } : {}),
      ...(gptView.state === 'unstated' && gptView.defaultEffort !== undefined
        ? { providerDefault: gptView.defaultEffort }
        : {}),
    })
  }

  // Every other id resolves through THE ONE per-model vocabulary owner
  // (effortVocabularyFor — the capability edge, the same pins and live rows
  // the wire builders send from).
  const view = effortVocabularyFor(model)
  const rawRequest =
    envOverride === null ? undefined : envOverride !== undefined ? envOverride : appStateEffortValue

  // Branch 2: honest absence — a model with no effort control. No stop is
  // offered, the wire carries no key, the label is the one absence word;
  // the request is preserved as intent (it follows the operator to the next
  // effort-capable model). Hugging Face, the compat slot and every other
  // no-dial id used to borrow the first-party default word 'high' here.
  if (view.kind === 'none') {
    return freeze({
      model,
      catalogue: 'static-tables',
      requested: rawRequest,
      requestedSource,
      supportsEffort: false,
      selectable: [],
      appliedValue: undefined,
      applied: undefined,
      wire: undefined,
      label: NO_EFFORT_CONTROL_LABEL,
      ...(view.defaultEffort !== undefined ? { providerDefault: view.defaultEffort } : {}),
    })
  }

  // Branch 3: a provider's own per-model vocabulary — GLM (per model), Kimi
  // K3, DeepSeek, a Gemini thinking row, an OpenRouter row, a local server
  // kind. The truth resolves against the SAME vocabulary the wire resolves
  // against, nearest-below (zaiCallModel · compatWire's builders), so the
  // label names the tier the request carries:
  //   · the GLM branch tested the UNION vocabulary, so glm-5.3 displayed
  //     xhigh or medium while the wire sent high or low (FN-018 rank 7);
  //   · Kimi and DeepSeek rode the first-party ladder, which treats
  //     low/medium/high as universal, so 'medium' displayed medium on the
  //     chip, the slider, /effort and the byline while the wire stepped it
  //     to low (FN-018 rank 6); an OpenRouter row stating only high|max
  //     showed medium the same way.
  // A thinking-gated lane (the dial IS the reasoning dial) with the
  // session's thinking off sends no dial, exactly as its builder does: the
  // record says so (suppressedBy) instead of naming a tier never sent.
  if (view.kind === 'provider') {
    const vocabulary = view.vocabulary
    const request = typeof rawRequest === 'string' ? rawRequest : undefined
    const suppressed = view.thinkingGated && !(context.thinkingEnabled ?? sessionThinkingEnabled())
    const wire =
      suppressed || request === undefined
        ? undefined
        : vocabulary.includes(request)
          ? request
          : nearestSupportedWireEffort(request, [...vocabulary])
    const adjustedFrom =
      !suppressed && request !== undefined && isEffortLevel(request) && request !== wire ? request : undefined
    const applied = wire !== undefined && isEffortLevel(wire) ? wire : undefined
    return freeze({
      model,
      catalogue: 'documented-vocabulary',
      requested: request,
      requestedSource,
      supportsEffort: true,
      selectable: EFFORT_LEVELS.filter(level => vocabulary.includes(level)),
      appliedValue: applied,
      applied,
      wire,
      label: wire ?? EXTERNAL_DEFAULT_LABEL,
      ...(adjustedFrom !== undefined ? { adjustedFrom } : {}),
      providerVocabulary: [...vocabulary],
      ...(view.defaultEffort !== undefined ? { providerDefault: view.defaultEffort } : {}),
      ...(suppressed ? { suppressedBy: 'thinking-off' as const } : {}),
    })
  }

  // Branch 4: the first-party ladder (the offered kind is a GPT state and
  // returned above; it rides here as the full ladder by construction).
  const selectable: readonly EffortLevel[] = view.kind === 'ladder' ? view.vocabulary : EFFORT_LEVELS
  if (envOverride === null) {
    return freeze({
      model,
      catalogue: 'static-tables',
      requested: undefined,
      requestedSource,
      supportsEffort: true,
      selectable,
      appliedValue: undefined,
      applied: undefined,
      wire: undefined,
      label: FIRST_PARTY_DEFAULT_LEVEL,
    })
  }
  const requested = rawRequest
  const base = requested ?? getDefaultEffortForModel(model)
  if (base === undefined) {
    return freeze({
      model,
      catalogue: 'static-tables',
      requested,
      requestedSource,
      supportsEffort: true,
      selectable,
      appliedValue: undefined,
      applied: undefined,
      wire: undefined,
      label: FIRST_PARTY_DEFAULT_LEVEL,
    })
  }
  const stepped = stepDown(model, base)
  const appliedLevel = convertEffortValueToLevel(stepped)
  const wire = typeof stepped === 'number' ? String(stepped) : stepped
  const adjustedFrom =
    typeof base === 'string' && isEffortLevel(base) && base !== stepped ? base : undefined
  return freeze({
    model,
    catalogue: 'static-tables',
    requested,
    requestedSource,
    supportsEffort: true,
    selectable,
    appliedValue: stepped,
    applied: typeof stepped === 'number' ? undefined : appliedLevel,
    wire,
    label: appliedLevel,
    ...(adjustedFrom !== undefined ? { adjustedFrom } : {}),
  })
}

//
// Projections
//

export function resolveAppliedEffort(model: string, appStateEffortValue: EffortValue | undefined): EffortValue | undefined {
  return resolveEffortTruth(model, appStateEffortValue).appliedValue
}

export function selectableEffortLevels(model: string): readonly EffortLevel[] {
  return resolveEffortTruth(model, undefined).selectable
}

/** The requested string for providers that resolve their own vocabulary. */
export function resolveWireRequestedEffort(model: string, appStateEffortValue: EffortValue | undefined): string | undefined {
  const requested = resolveEffortTruth(model, appStateEffortValue).requested
  return typeof requested === 'string' ? requested : undefined
}

/** The ladder-typed displayed level, for symbols and slot indices. */
export function getDisplayedEffortLevel(model: string, appStateEffort: EffortValue | undefined): EffortLevel {
  const applied = resolveEffortTruth(model, appStateEffort).appliedValue
  return applied !== undefined ? convertEffortValueToLevel(applied) : FIRST_PARTY_DEFAULT_LEVEL
}

/** The truthful word: the wire tier, or the appropriate default word. */
export function getDisplayedEffortLabel(model: string, appStateEffort: EffortValue | undefined): string {
  return resolveEffortTruth(model, appStateEffort).label
}

/**
 * The spinner/logo suffix: empty when no value was supplied or the wire
 * omits the parameter; otherwise a phrase beginning with a space (it is
 * concatenated onto an existing line).
 */
export function getEffortSuffix(model: string, effortValue: EffortValue | undefined): string {
  if (effortValue === undefined) return ''
  const resolution = resolveEffortTruth(model, effortValue)
  if (resolution.wire === undefined) return ''
  return ` with ${resolution.label} effort`
}

/**
 * Cycle one stop along the offered set. A current value that is not itself
 * selectable is first projected onto the nearest offered stop at or below
 * it, so one keypress advances exactly one stop.
 */
export function cycleSelectableEffort(
  model: string,
  current: EffortLevel | undefined,
  direction: 'left' | 'right',
): EffortLevel {
  const stops = selectableEffortLevels(model)
  if (stops.length === 0) return current ?? FIRST_PARTY_DEFAULT_LEVEL
  let index = current !== undefined ? stops.indexOf(current) : -1
  if (index === -1 && current !== undefined) {
    const currentRank = EFFORT_LEVELS.indexOf(current)
    for (let i = stops.length - 1; i >= 0; i--) {
      if (EFFORT_LEVELS.indexOf(stops[i] as EffortLevel) <= currentRank) {
        index = i
        break
      }
    }
  }
  if (index === -1) {
    const defaultIndex = stops.indexOf(FIRST_PARTY_DEFAULT_LEVEL)
    index = defaultIndex === -1 ? 0 : defaultIndex
  }
  const next = direction === 'right' ? (index + 1) % stops.length : (index - 1 + stops.length) % stops.length
  return stops[next] as EffortLevel
}

/** A string names a level or coerces to the default; a number is the default. */
export function convertEffortValueToLevel(v: EffortValue): EffortLevel {
  if (typeof v === 'string') return isEffortLevel(v) ? v : FIRST_PARTY_DEFAULT_LEVEL
  return FIRST_PARTY_DEFAULT_LEVEL
}

//
// Descriptions
//

/**
 * The family probe table: one row per family, probes ordered widest-first;
 * a row contributes the display name of its first supported probe. Never a
 * hand-maintained list — one went stale and omitted a whole family.
 */
const FAMILY_PROBES: Array<{ display: string; probes: string[] }> = [
  { display: 'Opus 4.5+', probes: ['claude-opus-4-5'] },
  { display: 'Opus 4.7+', probes: ['claude-opus-4-7'] },
  { display: 'Sonnet 4.6+', probes: ['claude-sonnet-4-6'] },
  { display: 'Sonnet 5', probes: ['claude-sonnet-5'] },
  { display: 'Fable', probes: ['claude-fable-5', 'claude-fable-5-1'] },
  // The GPT row probes representative ids; capability is the live catalogue's
  // per-model answer (a generation label here would be a pinned era fact).
  { display: 'GPT', probes: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
]

/** The families whose first supported probe passes the predicate, joined. */
export function effortFamiliesLabel(supports: (modelId: string) => boolean): string {
  const names: string[] = []
  for (const row of FAMILY_PROBES) {
    if (row.probes.some(probe => supports(probe))) {
      names.push(row.display)
    }
  }
  return names.join(', ')
}

export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Fastest and lightest — the smallest amount of work that answers.'
    case 'medium':
      return 'The middle road — a normal implementation plus the tests that go with it.'
    case 'high':
      return 'Thorough — implementation with substantial test coverage and written documentation.'
    case 'xhigh':
      return `Extra depth of reasoning — the right pick for difficult coding and long agentic runs · ${effortFamiliesLabel(modelSupportsXHighEffort)}`
    case 'max':
      return `The model's fullest capability and deepest reasoning · ${effortFamiliesLabel(modelSupportsMaxEffort)}`
  }
}

/** A value-level description with the family-specific hint on the high tier. */
export function getEffortValueDescription(value: EffortValue, model?: string): string {
  if (typeof value === 'number') return getEffortLevelDescription('medium')
  const base = getEffortLevelDescription(value)
  if (value === 'high' && model !== undefined && model.toLowerCase().includes('opus')) {
    return `${base} This tier burns fastest; medium handles most tasks.`
  }
  return base
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const DEFAULT_OPUS_EFFORT_CONFIG: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'Medium effort is recommended for Opus',
  dialogDescription:
    'Effort determines how long Mercury thinks. Medium is recommended for most tasks to balance speed, intelligence and rate limits. The deepthink keyword is a prompt-level nudge for a single turn and leaves the configured effort level unchanged.',
}

/** The local defaults with the remote value spread over them, field by field. */
export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const remote = getFeatureValue_CACHED_MAY_BE_STALE<Partial<OpusDefaultEffortConfig>>(
    'mercury_grey_step2',
    DEFAULT_OPUS_EFFORT_CONFIG,
  )
  return { ...DEFAULT_OPUS_EFFORT_CONFIG, ...remote }
}

//
// Launch-effort pinning
//

type LaunchFamily = 'opus47' | 'opus48' | 'fable5' | 'fable51' | 'sonnet5' | 'opus5'

// Substring rules mirror the capability predicates so first- and
// third-party id formats behave consistently. Order matters where one
// substring contains another: the Fable 5.1 row sits above the bare
// 'fable' family row so 5.1 pins its OWN launch flag (the docs' default is
// `high`, and a fresh sweep is recommended over a Fable 5 setting).
const LAUNCH_FAMILIES: Array<{ substring: string; flag: LaunchFamily; launchDefault: EffortLevel }> = [
  { substring: 'opus-4-7', flag: 'opus47', launchDefault: 'xhigh' },
  { substring: 'opus-4-8', flag: 'opus48', launchDefault: 'high' },
  { substring: 'fable-5-1', flag: 'fable51', launchDefault: 'high' },
  { substring: 'fable', flag: 'fable5', launchDefault: 'high' },
  { substring: 'sonnet-5', flag: 'sonnet5', launchDefault: 'high' },
  { substring: 'opus-5', flag: 'opus5', launchDefault: 'high' },
]

function readUnpins(): Partial<Record<LaunchFamily, boolean>> {
  return (getGlobalConfig() as { launchEffortUnpins?: Partial<Record<LaunchFamily, boolean>> })
    .launchEffortUnpins ?? {}
}

export function allLaunchEffortUnpinned(): boolean {
  const unpins = readUnpins()
  return LAUNCH_FAMILIES.every(family => unpins[family.flag] === true)
}

/**
 * Is a model launch-pinned? A LAUNCH_FAMILIES row pins its family's launch
 * default until the operator sets that family's unpin flag.
 */
export function isLaunchEffortPinned(model: string): boolean {
  const lowered = model.toLowerCase()
  const unpins = readUnpins()
  for (const family of LAUNCH_FAMILIES) {
    if (lowered.includes(family.substring)) {
      return unpins[family.flag] !== true
    }
  }
  return false
}

/** Idempotent: sets every family flag in one config save. */
export function unpinAllLaunchEffort(): void {
  if (allLaunchEffortUnpinned()) return
  saveGlobalConfig(current => ({
    ...current,
    launchEffortUnpins: { opus47: true, opus48: true, fable5: true, fable51: true, sonnet5: true, opus5: true },
  }))
}

export function getLaunchDefaultEffort(model: string): EffortLevel {
  const lowered = model.toLowerCase()
  for (const family of LAUNCH_FAMILIES) {
    if (lowered.includes(family.substring)) return family.launchDefault
  }
  return 'high'
}

/**
 * The default effort for a model. Changing a default effort is a
 * sensitive, notify-first change: it materially affects model quality and
 * usage.
 */
export function getDefaultEffortForModel(model: string): EffortValue | undefined {
  // 1. The external reasoning provider's catalogue default keeps the
  //    displayed default identical to the dispatched one.
  const gptDefault = gptModelDefaultEffort(model)
  if (gptDefault !== undefined) return gptDefault
  // 2. Either external provider resolves its own default and must never
  //    take the ladder arms below.
  {
    const view = gptEffortVocabularyView(model)
    if (view.state !== 'not-gpt') return undefined
    if (isGlmModelId(model)) return undefined
  }
  // 3. Launch pin.
  if (isLaunchEffortPinned(model)) return getLaunchDefaultEffort(model)
  // 4. Subscription-tier rule for the opus-4-6 family.
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) return 'medium'
    if ((isMaxSubscriber() || isTeamSubscriber() || isEnterpriseSubscriber()) && getOpusDefaultEffortConfig().enabled) {
      return 'medium'
    }
  }
  // 5. Deep-reasoning feature on and the model supports effort.
  if (isDeepthinkEnabled() && modelSupportsEffort(model)) return 'medium'
  // 6. No parameter; the API applies its documented default.
  return undefined
}

/**
 * The loops a user submission drives; service loops (compaction, session
 * memory, classifiers, summaries) run nested under the same main-thread key
 * and must neither inherit nor revert turn-scoped overrides.
 */
export function isTurnOwningQuerySource(querySource: string | undefined): boolean {
  if (querySource === undefined) return false
  return querySource.startsWith('repl_main_thread') || querySource === 'sdk' || querySource.startsWith('agent:')
}

/**
 * Whether picking a new effort value should re-prompt the user. The guards
 * are evaluated in this order and with this nesting — the last two are
 * mutually exclusive branches: on a launch-pinned model the applied-effort
 * comparison is NOT evaluated.
 */
export function shouldReconfirmEffortAfterModelChange(
  newValue: EffortValue | undefined,
  appStateEffort: EffortValue | undefined,
  model: string,
  hasConversation: boolean,
): boolean {
  if (!hasConversation) return false
  if (!modelSupportsEffort(model)) return false
  if (isLaunchEffortPinned(model)) {
    if (newValue === undefined || newValue === getLaunchDefaultEffort(model)) return false
    return true
  }
  if (resolveAppliedEffort(model, newValue) === resolveAppliedEffort(model, appStateEffort)) return false
  return true
}
