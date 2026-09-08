import { flagEnv } from '../../substrate/flagRegistry.js'
import { connectToBrowseReason, type CatalogueFamily } from '../../services/providers/catalogueGate.js'
import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../config.js'
import {
  EFFORT_LEVELS,
  NO_EFFORT_CONTROL_LABEL,
  normalizeEffortLevelString,
  resolveEffortTruth,
  type EffortLevel,
  type EffortTruthContext,
} from '../effort.js'
import {
  providerDisplayName,
  declaredRouteOf,
  type CallModelRoute,
} from '../../services/providers/routeLaw.js'
import {
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../../services/providers/providerUsage.js'
import {
  buildRouterModelSnapshot,
  type RouterModelSnapshot,
} from '../router/modelRegistry.js'
import {
  getModelOptions,
  isProviderActionRow,
  stripContext1m,
  type ModelOption,
} from './modelOptions.js'
import { parseUserSpecifiedModel } from './model.js'

export type SubModelContainer = 'minerva' | 'console'

export const SUB_MODEL_CONTAINERS: readonly SubModelContainer[] = ['minerva', 'console']

export const SUB_MODEL_UNSET_HINT = 'use /submodels to pin one of the available model catalogues'

export function subModelEnvVar(container: SubModelContainer): string {
  return container === 'minerva' ? 'MERCURY_MINERVA_MODEL' : 'MERCURY_CONSOLE_MODEL'
}

export function canonicalSubModelId(value: string): string {
  return stripContext1m(parseUserSpecifiedModel(stripContext1m(value.trim())))
}

export type SubModelOrigin = 'env' | 'saved' | 'unset'

export interface SubModelPin {
  origin: 'env' | 'saved'
  model: string
  route: CallModelRoute | 'unrecognised'
  envVar?: string
}

export interface SubModelUnset {
  origin: 'unset'
  hint: string
}

export type SubModelResolution = SubModelPin | SubModelUnset

function savedSubModels(): ReturnType<typeof getGlobalConfig>['subModels'] {
  return isConfigReadingAllowed() ? getGlobalConfig().subModels : undefined
}

export function resolveSubModel(container: SubModelContainer): SubModelResolution {
  const envVar = subModelEnvVar(container)
  const envRaw = flagEnv(envVar)
  if (envRaw !== undefined && envRaw.trim() !== '') {
    const model = canonicalSubModelId(envRaw)
    return { origin: 'env', model, route: declaredRouteOf(model) ?? 'unrecognised', envVar }
  }
  const saved = savedSubModels()?.[container]
  if (saved !== undefined && saved.trim() !== '') {
    const model = canonicalSubModelId(saved)
    return { origin: 'saved', model, route: declaredRouteOf(model) ?? 'unrecognised' }
  }
  return { origin: 'unset', hint: SUB_MODEL_UNSET_HINT }
}

export function consoleModelOverride(sessionModel: string): string | undefined {
  const resolved = resolveSubModel('console')
  if (resolved.origin === 'unset') return undefined
  return canonicalSubModelId(sessionModel) === canonicalSubModelId(resolved.model)
    ? undefined
    : resolved.model
}

export function subModelIdentityLine(container: SubModelContainer, pin: SubModelPin): string {
  const name =
    container === 'minerva' ? 'Minerva, the notepad curator' : 'the Console, the side-question assistant'
  return (
    `Engine identity — a fact stamped by the Mercury harness (you cannot know it on your own): ` +
    `you are ${name}, running on model id "${pin.model}" via the ${providerDisplayName(pin.route)} wire. ` +
    `When asked what model you are, answer with exactly that id and wire; never guess another name.`
  )
}


export type SubModelRowState = 'selectable' | 'signed-out' | 'refused'

export interface SubModelEntry {
  kind: 'model' | 'connect'
  modelId: string
  displayName: string
  source: CallModelRoute | 'unrecognised'
  state: SubModelRowState
  reason?: string
  connect?: { command?: string; note: string }
  description?: string
}

export interface SubModelFamily {
  source: CallModelRoute | 'unrecognised'
  label: string
  credentialed: boolean
  credentialLabel?: string
}

export interface SubModelRegistry {
  entries: SubModelEntry[]
  families: SubModelFamily[]
}

export function subModelConnectHome(route: CallModelRoute | string): {
  command?: string
  note: string
} {
  switch (route) {
    case 'anthropic':
      return { command: '/logins anthropic', note: 'sign in — /logins' }
    case 'openai':
      return { command: '/logins openai', note: 'sign in — /logins' }
    case 'openrouter':
      return { command: '/logins openrouter', note: 'connect — /logins' }
    case 'gemini':
      return { command: '/logins gemini', note: 'connect — /logins' }
    case 'zai':
      return { command: '/logins zai', note: 'connect — /logins (API key)' }
    case 'moonshot':
      return { command: '/logins moonshot', note: 'sign in — /logins' }
    case 'deepseek':
      return { command: '/logins deepseek', note: 'connect — /logins (API key)' }
    case 'openai-compat':
      return { note: 'MERCURY_COMPAT_BASE_URL configures the endpoint (key optional — /router key compat)' }
    case 'huggingface':
      return { command: '/logins huggingface', note: 'sign in — /logins' }
    case 'local':
      return {
        note: 'no sign-in — start a local server (Ollama · LM Studio · vLLM · llama.cpp) or set MERCURY_LOCAL_BASE_URL',
      }
    default:
      return { command: '/logins', note: 'sign in — /logins' }
  }
}

export interface SubModelRegistryReads {
  options?: () => ModelOption[]
  presences?: () => ProviderFamilyPresence[]
  providers?: () => RouterModelSnapshot['providers']
}

export function composeSubModelRegistry(reads: SubModelRegistryReads = {}): SubModelRegistry {
  const providers = (reads.providers ?? (() => buildRouterModelSnapshot().providers))()
  const presences = (reads.presences ?? (() => providerFamilyPresences(providers)))()
  const presenceOf = new Map(presences.map(presence => [presence.id as string, presence]))
  const credentialed = (route: CallModelRoute | 'unrecognised'): boolean =>
    presenceOf.get(route)?.credentialed ?? false

  const entries: SubModelEntry[] = []
  const seen = new Set<string>()
  const options = (
    reads.options ??
    (() => getModelOptions({ anthropicCredentialed: () => credentialed('anthropic') }))
  )()
  for (const option of options) {
    const value = option.value
    if (!value || value.startsWith('__')) continue
    if (isProviderActionRow(value)) continue
    const modelId = canonicalSubModelId(value)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const route = declaredRouteOf(modelId) ?? 'unrecognised'
    const description = option.description.length > 0 ? { description: option.description } : {}
    if (!credentialed(route)) {
      const home = subModelConnectHome(route)
      entries.push({
        kind: 'model',
        modelId,
        displayName: option.label,
        source: route,
        state: 'signed-out',
        reason: option.unavailable ?? 'not signed in',
        connect: home,
        ...description,
      })
      continue
    }
    if (option.unavailable !== undefined) {
      entries.push({
        kind: 'model',
        modelId,
        displayName: option.label,
        source: route,
        state: 'refused',
        reason: option.unavailable,
        ...description,
      })
      continue
    }
    entries.push({
      kind: 'model',
      modelId,
      displayName: option.label,
      source: route,
      state: 'selectable',
      ...description,
    })
  }

  const catalogueGated = new Set<CallModelRoute>(['huggingface', 'openrouter', 'gemini', 'openai'])
  for (const presence of presences) {
    const route = presence.id as CallModelRoute
    if (entries.some(entry => entry.source === route)) continue
    const home = subModelConnectHome(route)
    entries.push({
      kind: 'connect',
      modelId: `connect:${presence.id}`,
      displayName: presence.credentialed
        ? `${providerDisplayName(presence.id)} — no models listed`
        : `${providerDisplayName(presence.id)} — ${home.command !== undefined ? 'sign in' : 'configure'}`,
      source: route,
      state: presence.credentialed ? 'refused' : 'signed-out',
      ...(presence.credentialed
        ? { reason: presence.reason ?? 'no models in the live catalogue' }
        : {
            reason: catalogueGated.has(route)
              ? connectToBrowseReason(route as Exclude<CatalogueFamily, 'local'>)
              : 'not signed in',
            connect: home,
          }),
      description: home.note,
    })
  }

  const families: SubModelFamily[] = []
  for (const entry of entries) {
    if (families.some(family => family.source === entry.source)) continue
    const presence = presenceOf.get(entry.source)
    families.push({
      source: entry.source,
      label: providerDisplayName(entry.source),
      credentialed: presence?.credentialed ?? false,
      ...(presence?.credentialLabel !== undefined
        ? { credentialLabel: presence.credentialLabel }
        : {}),
    })
  }
  return { entries, families }
}


export type SubModelSetResult =
  | { ok: true; receipt: string }
  | { ok: false; reason: string }

export function setSubModel(
  container: SubModelContainer,
  modelId: string | null,
  reads: SubModelRegistryReads = {},
): SubModelSetResult {
  const envVar = subModelEnvVar(container)
  const envRaw = flagEnv(envVar)
  if (envRaw !== undefined && envRaw.trim() !== '') {
    return {
      ok: false,
      reason: `${container} is pinned by ${envVar} this session — unset it to pick here`,
    }
  }
  const label = container === 'minerva' ? 'Minerva' : 'Console'
  if (modelId === null) {
    const had = getGlobalConfig().subModels?.[container] !== undefined
    if (had) {
      saveGlobalConfig(config => {
        const next = { ...config.subModels }
        delete next[container]
        return { ...config, subModels: Object.keys(next).length > 0 ? next : undefined }
      })
    }
    return {
      ok: true,
      receipt: `${label} model unset — ${SUB_MODEL_UNSET_HINT}`,
    }
  }
  const wanted = canonicalSubModelId(modelId)
  const entry = composeSubModelRegistry(reads).entries.find(
    candidate => candidate.kind === 'model' && candidate.modelId === wanted,
  )
  if (!entry) return { ok: false, reason: `${wanted} is not in the live catalogue` }
  if (entry.state !== 'selectable') {
    const route = entry.connect !== undefined ? ` · ${entry.connect.note}` : ''
    return { ok: false, reason: `${entry.displayName}: ${entry.reason ?? 'not selectable'}${route}` }
  }
  saveGlobalConfig(config => ({
    ...config,
    subModels: { ...config.subModels, [container]: wanted },
  }))
  return {
    ok: true,
    receipt: `${label} model set to ${entry.displayName} (${providerDisplayName(entry.source)}) — ${subModelEffortClause(container, wanted)} — live on the next ${container === 'minerva' ? 'curator pass' : 'side question'}`,
  }
}


function containerLabel(container: SubModelContainer): string {
  return container === 'minerva' ? 'Minerva' : 'Console'
}

export function subModelEffortContext(container: SubModelContainer): EffortTruthContext {
  return container === 'minerva' ? { thinkingEnabled: false } : {}
}

export function resolveSubModelEffort(container: SubModelContainer): EffortLevel | undefined {
  const stored = savedSubModels()?.effort?.[container]
  return stored === undefined ? undefined : normalizeEffortLevelString(stored)
}

export type SubModelEffortStrip =
  | { kind: 'levels'; levels: readonly EffortLevel[]; current: EffortLevel }
  | { kind: 'none'; receipt: string }

export function subModelEffortStrip(container: SubModelContainer, model: string): SubModelEffortStrip {
  const truth = resolveEffortTruth(model, undefined, subModelEffortContext(container))
  if (!truth.supportsEffort) {
    return { kind: 'none', receipt: `${model} has ${NO_EFFORT_CONTROL_LABEL}` }
  }
  if (truth.suppressedBy === 'thinking-off') {
    return {
      kind: 'none',
      receipt: `${model}: its effort dial is its reasoning dial, and ${containerLabel(container)} calls with thinking off — no level applies`,
    }
  }
  if (truth.flooredBy === 'thinking-off') {
    return {
      kind: 'none',
      receipt: `${model}: its effort dial is its reasoning dial, and ${containerLabel(container)} calls with thinking off — it sends ${truth.wire}, the lowest it serves`,
    }
  }
  const levels = truth.selectable
  const chosen = resolveSubModelEffort(container)
  const current =
    chosen !== undefined && levels.includes(chosen)
      ? chosen
      : truth.applied !== undefined && levels.includes(truth.applied)
        ? truth.applied
        : levels.includes('high')
          ? 'high'
          : (levels[0] as EffortLevel)
  return { kind: 'levels', levels, current }
}

export interface SubModelEffortDispatch {
  effortValue: EffortLevel | undefined
  chosen: EffortLevel | undefined
  fallback?: string
}

export function subModelDispatchEffort(container: SubModelContainer, model: string): SubModelEffortDispatch {
  const chosen = resolveSubModelEffort(container)
  if (chosen === undefined) return { effortValue: undefined, chosen }
  const truth = resolveEffortTruth(model, chosen, subModelEffortContext(container))
  const label = containerLabel(container)
  if (!truth.supportsEffort) {
    return {
      effortValue: undefined,
      chosen,
      fallback: `${model} has ${NO_EFFORT_CONTROL_LABEL} — ${chosen} stays saved and applies when ${label} runs an effort-capable model`,
    }
  }
  if (truth.suppressedBy === 'thinking-off') {
    return {
      effortValue: undefined,
      chosen,
      fallback: `${model} sends no effort dial on ${label}'s thinking-off calls and runs its provider default — ${chosen} stays saved, not sent`,
    }
  }
  if (truth.flooredBy === 'thinking-off') {
    return {
      effortValue: undefined,
      chosen,
      fallback: `${model} sends ${truth.wire} on ${label}'s thinking-off calls (the lowest it serves) — ${chosen} stays saved, not sent`,
    }
  }
  if (!truth.selectable.includes(chosen)) {
    const runs = resolveEffortTruth(model, undefined, subModelEffortContext(container)).label
    return {
      effortValue: undefined,
      chosen,
      fallback: `${model} does not offer ${chosen} — runs @${runs} (the model default); ${chosen} stays saved`,
    }
  }
  return { effortValue: chosen, chosen }
}

export function subModelEffortClause(container: SubModelContainer, model: string): string {
  const dispatch = subModelDispatchEffort(container, model)
  if (dispatch.fallback !== undefined) return dispatch.fallback
  const truth = resolveEffortTruth(model, dispatch.effortValue, subModelEffortContext(container))
  if (!truth.supportsEffort) return NO_EFFORT_CONTROL_LABEL
  if (truth.requestedSource === 'env') return `runs @${truth.label} (pinned by MERCURY_EFFORT_LEVEL)`
  if (dispatch.chosen === undefined) return `runs @${truth.label} (the model default)`
  return truth.label === dispatch.chosen
    ? `runs @${truth.label} (chosen)`
    : `runs @${truth.label} (${dispatch.chosen} chosen — resolved live at dispatch)`
}

export function setSubModelEffort(container: SubModelContainer, effortWord: string | null): SubModelSetResult {
  const label = containerLabel(container)
  if (effortWord === null) {
    const had = getGlobalConfig().subModels?.effort?.[container] !== undefined
    if (had) {
      saveGlobalConfig(config => {
        const effort = { ...config.subModels?.effort }
        delete effort[container]
        const next = { ...config.subModels }
        if (Object.keys(effort).length > 0) next.effort = effort
        else delete next.effort
        return { ...config, subModels: Object.keys(next).length > 0 ? next : undefined }
      })
    }
    return { ok: true, receipt: `${label} effort cleared — the model default applies` }
  }
  const level = normalizeEffortLevelString(effortWord)
  if (level === undefined) {
    return {
      ok: false,
      reason: `'${effortWord}' is not on the effort ladder — the levels are ${EFFORT_LEVELS.join(' | ')}`,
    }
  }
  saveGlobalConfig(config => ({
    ...config,
    subModels: { ...config.subModels, effort: { ...config.subModels?.effort, [container]: level } },
  }))
  const pin = resolveSubModel(container)
  const clause =
    pin.origin === 'unset'
      ? 'applies when a model is pinned'
      : `${pin.model} ${subModelEffortClause(container, pin.model)}`
  return { ok: true, receipt: `${label} effort set to ${level} — ${clause}` }
}
