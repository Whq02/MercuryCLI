import { EFFORT_LEVELS, type EffortLevel } from '../entrypoints/sdk/runtimeTypes.js'
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
  modelOffersEffortLevel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from './model/capabilities.js'
import { resolveAntModel } from './model/antModels.js'
import { getInitialSettings, getSettingsForSource } from './settings/settings.js'
import { isDeepthinkEnabled, sessionThinkingEnabled } from './thinking.js'


export type { EffortLevel }
export type EffortValue = EffortLevel | number

export { EFFORT_LEVELS }

export { modelOffersEffortLevel, modelSupportsEffort, modelSupportsMaxEffort, modelSupportsXHighEffort, getMaxSupportedEffortLevel }

const FIRST_PARTY_DEFAULT_LEVEL: EffortLevel = 'high'
const EXTERNAL_DEFAULT_LABEL = 'default'
export const NO_EFFORT_CONTROL_LABEL = 'no effort control'

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

export function parseEffortValue(v: unknown): EffortValue | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number' && isValidNumericEffort(v)) return v
  const text = String(v).trim().toLowerCase()
  const level = normalizeEffortLevelString(text)
  if (level !== undefined) return level
  const numeric = parseInt(text, 10)
  return isValidNumericEffort(numeric) ? numeric : undefined
}

export function normalizeEffortLevelString(input: string): EffortLevel | undefined {
  const worded = input.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  const collapsed = worded.replace(/\beffort\b/g, '').replace(/\s+/g, '')
  const level = ALIASES[collapsed] ?? collapsed
  return isEffortLevel(level) ? level : undefined
}

export function parseCliEffort(input: string): { level: EffortLevel; refusal?: undefined } | { level: undefined; refusal: string } {
  const level = normalizeEffortLevelString(input)
  if (level) return { level }
  return {
    level: undefined,
    refusal: `Unrecognised effort level "${input}". Valid values: ${EFFORT_LEVELS.join(', ')}.`,
  }
}

export function toPersistableEffort(v: EffortValue | undefined): EffortLevel | undefined {
  return typeof v === 'string' && isEffortLevel(v) ? v : undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  return toPersistableEffort(getInitialSettings().effortLevel as EffortValue | undefined)
}

export function getInitialSupercodeSetting(): boolean {
  return getInitialSettings().supercodeEffort === true
}

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

export function getEffortEnvOverride(): EffortLevel | null | undefined {
  return describeEffortEnvOverride().override
}


const agentEffortWords = new Map<string, EffortValue>()

export function noteAgentEffortWord(agentId: string, word: EffortValue | undefined): void {
  if (word === undefined) agentEffortWords.delete(agentId)
  else agentEffortWords.set(agentId, word)
}

export function forgetAgentEffortWord(agentId: string): void {
  agentEffortWords.delete(agentId)
}

export function agentOwnEffortWordOf(agentId: string | undefined): EffortValue | undefined {
  return agentId === undefined ? undefined : agentEffortWords.get(agentId)
}

export type EffortEnvOverrideView =
  | { state: 'absent'; override: undefined }
  | { state: 'deferred'; raw: string; override: null }
  | { state: 'level'; raw: string; override: EffortLevel }
  | { state: 'ignored'; raw: string; override: undefined; sentence: string }

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
  readonly requestedSource: 'agent' | 'env' | 'env-suppressed' | 'session' | 'none'
  readonly supportsEffort: boolean
  readonly selectable: readonly EffortLevel[]
  readonly appliedValue: EffortValue | undefined
  readonly applied: EffortLevel | undefined
  readonly wire: string | undefined
  readonly label: string
  readonly adjustedFrom?: EffortLevel
  readonly providerVocabulary?: readonly string[]
  readonly providerDefault?: string
  readonly suppressedBy?: 'thinking-off'
}

export type EffortTruthContext = {
  readonly thinkingEnabled?: boolean
  readonly agentId?: string
}

export function selectableEffortLevelsForLadder(model: string): readonly EffortLevel[] {
  const view = effortVocabularyFor(model)
  return view.kind === 'ladder' ? view.vocabulary : []
}

function stepDown(model: string, value: EffortValue): EffortValue {
  if (typeof value !== 'string' || !isEffortLevel(value)) return value
  for (let rank = EFFORT_LEVELS.indexOf(value); rank >= 0; rank--) {
    const level = EFFORT_LEVELS[rank] as EffortLevel
    if (modelOffersEffortLevel(model, level)) return level
  }
  return value
}

export function resolveEffortTruth(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  context: EffortTruthContext = {},
): EffortResolution {
  return resolveEffortTruthWithEnv(model, appStateEffortValue, getEffortEnvOverride(), context)
}

export function resolveStampedEffortTruth(
  model: string,
  stamped: EffortValue | undefined,
  context: EffortTruthContext = {},
): EffortResolution {
  return resolveEffortTruthWithEnv(model, stamped, undefined, context)
}

function resolveEffortTruthWithEnv(
  model: string,
  sessionEffortValue: EffortValue | undefined,
  sessionEnvOverride: EffortValue | null | undefined,
  context: EffortTruthContext,
): EffortResolution {
  resolveAntModel(model)
  const freeze = (record: EffortResolution): EffortResolution => Object.freeze(record)

  const ownWord = agentOwnEffortWordOf(context.agentId)
  const envOverride = ownWord !== undefined ? undefined : sessionEnvOverride
  const appStateEffortValue = ownWord !== undefined ? (sessionEffortValue ?? ownWord) : sessionEffortValue

  const requestedSource: EffortResolution['requestedSource'] =
    ownWord !== undefined
      ? 'agent'
      : envOverride === null
        ? 'env-suppressed'
        : envOverride !== undefined
          ? 'env'
          : appStateEffortValue !== undefined
            ? 'session'
            : 'none'

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

  const view = effortVocabularyFor(model)
  const rawRequest =
    envOverride === null ? undefined : envOverride !== undefined ? envOverride : appStateEffortValue

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


export type EffortAdjustedV1 = { model: string; name: string; asked: string; sent?: string }

export function effortAdjustedReceiptLine(adjusted: EffortAdjustedV1): string {
  return adjusted.sent !== undefined
    ? `effort ${adjusted.asked} is not served on ${adjusted.name} today — sent ${adjusted.sent}`
    : `effort ${adjusted.asked} is not served on ${adjusted.name} today — no effort key was sent (the model default applies)`
}


export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  context: EffortTruthContext = {},
): EffortValue | undefined {
  return resolveEffortTruth(model, appStateEffortValue, context).appliedValue
}

export function selectableEffortLevels(model: string): readonly EffortLevel[] {
  return resolveEffortTruth(model, undefined).selectable
}

export function resolveWireRequestedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  context: EffortTruthContext = {},
): string | undefined {
  const requested = resolveEffortTruth(model, appStateEffortValue, context).requested
  return typeof requested === 'string' ? requested : undefined
}

export function getDisplayedEffortLevel(model: string, appStateEffort: EffortValue | undefined): EffortLevel {
  const applied = resolveEffortTruth(model, appStateEffort).appliedValue
  return applied !== undefined ? convertEffortValueToLevel(applied) : FIRST_PARTY_DEFAULT_LEVEL
}

export function getDisplayedEffortLabel(model: string, appStateEffort: EffortValue | undefined): string {
  return resolveEffortTruth(model, appStateEffort).label
}

export function getEffortSuffix(model: string, effortValue: EffortValue | undefined): string {
  if (effortValue === undefined) return ''
  const resolution = resolveEffortTruth(model, effortValue)
  if (resolution.wire === undefined) return ''
  return ` with ${resolution.label} effort`
}

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

export function convertEffortValueToLevel(v: EffortValue): EffortLevel {
  if (typeof v === 'string') return isEffortLevel(v) ? v : FIRST_PARTY_DEFAULT_LEVEL
  return FIRST_PARTY_DEFAULT_LEVEL
}


const FAMILY_PROBES: Array<{ display: string; probes: string[] }> = [
  { display: 'Opus 4.5+', probes: ['claude-opus-4-5'] },
  { display: 'Opus 4.7+', probes: ['claude-opus-4-7'] },
  { display: 'Sonnet 4.6+', probes: ['claude-sonnet-4-6'] },
  { display: 'Sonnet 5', probes: ['claude-sonnet-5'] },
  { display: 'Fable', probes: ['claude-fable-5', 'claude-fable-5-1'] },
  { display: 'GPT', probes: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
]

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
    case 'ultra':
      return `Beyond max — the deepest rung a served ladder carries, where the account serves it · ${effortFamiliesLabel(model => modelOffersEffortLevel(model, 'ultra'))}`
  }
}

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

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const remote = getFeatureValue_CACHED_MAY_BE_STALE<Partial<OpusDefaultEffortConfig>>(
    'mercury_grey_step2',
    DEFAULT_OPUS_EFFORT_CONFIG,
  )
  return { ...DEFAULT_OPUS_EFFORT_CONFIG, ...remote }
}


type LaunchFamily = 'opus47' | 'opus48' | 'fable5' | 'fable51' | 'sonnet5' | 'opus5'

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

export function getDefaultEffortForModel(model: string): EffortValue | undefined {
  const gptDefault = gptModelDefaultEffort(model)
  if (gptDefault !== undefined) return gptDefault
  {
    const view = gptEffortVocabularyView(model)
    if (view.state !== 'not-gpt') return undefined
    if (isGlmModelId(model)) return undefined
  }
  if (isLaunchEffortPinned(model)) return getLaunchDefaultEffort(model)
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) return 'medium'
    if ((isMaxSubscriber() || isTeamSubscriber() || isEnterpriseSubscriber()) && getOpusDefaultEffortConfig().enabled) {
      return 'medium'
    }
  }
  if (isDeepthinkEnabled() && modelSupportsEffort(model)) return 'medium'
  return undefined
}

export function isTurnOwningQuerySource(querySource: string | undefined): boolean {
  if (querySource === undefined) return false
  return querySource.startsWith('repl_main_thread') || querySource === 'sdk' || querySource.startsWith('agent:')
}

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
