import type { ModelOption } from '../../../utils/model/modelOptions.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import {
  canonicalWireModelId,
  healListedCatalogueRowId,
  qualifiedWireId,
  declaredRouteOf,
} from '../routeLaw.js'
import { OPENROUTER_REASONING_EFFORTS } from '../openaicompat/compatWire.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import {
  openrouterApiBase,
  resolveOpenrouterRequestAuth,
  type OpenrouterKeySource,
} from './openrouterAccounts.js'


const CATALOGUE_FETCH_TIMEOUT_MS = 15_000

export interface OpenrouterLiveModel {
  id: string
  name?: string
  description?: string
  contextLength?: number
  pricing?: {
    prompt?: string
    completion?: string
    request?: string
    inputCacheRead?: string
    inputCacheWrite?: string
  }
  supportedParameters?: readonly string[]
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
  maxCompletionTokens?: number
  expirationDate?: string
  createdAtS?: number
  reasoning?: {
    supportedEfforts?: readonly string[]
    defaultEffort?: string
    enabledByDefault?: boolean
    mandatory?: boolean
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
}

function decodeModel(raw: unknown): OpenrouterLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return undefined
  const architecture =
    typeof r.architecture === 'object' && r.architecture !== null
      ? (r.architecture as Record<string, unknown>)
      : undefined
  const pricing =
    typeof r.pricing === 'object' && r.pricing !== null
      ? (r.pricing as Record<string, unknown>)
      : undefined
  const topProvider =
    typeof r.top_provider === 'object' && r.top_provider !== null
      ? (r.top_provider as Record<string, unknown>)
      : undefined
  const decodedPricing = pricing
    ? {
        ...(str(pricing.prompt) !== undefined ? { prompt: str(pricing.prompt)! } : {}),
        ...(str(pricing.completion) !== undefined ? { completion: str(pricing.completion)! } : {}),
        ...(str(pricing.request) !== undefined ? { request: str(pricing.request)! } : {}),
        ...(str(pricing.input_cache_read) !== undefined ? { inputCacheRead: str(pricing.input_cache_read)! } : {}),
        ...(str(pricing.input_cache_write) !== undefined ? { inputCacheWrite: str(pricing.input_cache_write)! } : {}),
      }
    : undefined
  const reasoningRaw =
    typeof r.reasoning === 'object' && r.reasoning !== null
      ? (r.reasoning as Record<string, unknown>)
      : undefined
  const reasoning = reasoningRaw
    ? {
        ...(strArray(reasoningRaw.supported_efforts) !== undefined
          ? { supportedEfforts: strArray(reasoningRaw.supported_efforts)! }
          : {}),
        ...(str(reasoningRaw.default_effort) !== undefined
          ? { defaultEffort: str(reasoningRaw.default_effort)! }
          : {}),
        ...(typeof reasoningRaw.default_enabled === 'boolean'
          ? { enabledByDefault: reasoningRaw.default_enabled }
          : {}),
        ...(typeof reasoningRaw.mandatory === 'boolean' ? { mandatory: reasoningRaw.mandatory } : {}),
      }
    : undefined
  return {
    id,
    ...(str(r.name) !== undefined ? { name: str(r.name)! } : {}),
    ...(str(r.description) !== undefined ? { description: str(r.description)! } : {}),
    ...(num(r.context_length) !== undefined ? { contextLength: num(r.context_length)! } : {}),
    ...(decodedPricing && Object.keys(decodedPricing).length > 0 ? { pricing: decodedPricing } : {}),
    ...(strArray(r.supported_parameters) !== undefined
      ? { supportedParameters: strArray(r.supported_parameters)! }
      : {}),
    ...(strArray(architecture?.input_modalities) !== undefined
      ? { inputModalities: strArray(architecture?.input_modalities)! }
      : {}),
    ...(strArray(architecture?.output_modalities) !== undefined
      ? { outputModalities: strArray(architecture?.output_modalities)! }
      : {}),
    ...(num(topProvider?.max_completion_tokens) !== undefined
      ? { maxCompletionTokens: num(topProvider?.max_completion_tokens)! }
      : {}),
    ...(str(r.expiration_date) !== undefined ? { expirationDate: str(r.expiration_date)! } : {}),
    ...(num(r.created) !== undefined ? { createdAtS: num(r.created)! } : {}),
    ...(reasoning && Object.keys(reasoning).length > 0 ? { reasoning } : {}),
  }
}


const OPENROUTER_PAGE_LIMIT = 1000
const OPENROUTER_MAX_PAGES = 5

export async function fetchOpenrouterLiveModels(opts: {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<{ models: OpenrouterLiveModel[]; fetchedAtMs: number; incomplete?: string }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const models: OpenrouterLiveModel[] = []
  let incomplete: string | undefined
  let url = `${opts.baseUrl}/models?limit=${OPENROUTER_PAGE_LIMIT}&sort=most-popular`
  for (let page = 0; page < OPENROUTER_MAX_PAGES && url; page++) {
    const response = await fetchWithProviderDeadline(fetchImpl, 'openrouter', CATALOGUE_FETCH_TIMEOUT_MS, url, {
      method: 'GET',
      headers: { ...opts.headers, 'user-agent': getProductUserAgent() },
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? `openrouter models endpoint refused the credential (HTTP ${response.status})`
          : `openrouter models endpoint returned HTTP ${response.status}`,
      )
    }
    const parsed = (await response.json()) as Record<string, unknown>
    const data = Array.isArray(parsed.data) ? parsed.data : []
    for (const raw of data) {
      const model = decodeModel(raw)
      if (model) models.push(model)
    }
    const links =
      typeof parsed.links === 'object' && parsed.links !== null
        ? (parsed.links as Record<string, unknown>)
        : undefined
    const next = str(links?.next)
    if (!next && parsed.has_more === true) {
      incomplete = 'catalogue page signalled has_more without links.next — rows beyond this page were not fetched'
    }
    url = next ? (next.startsWith('http') ? next : `${opts.baseUrl.replace(/\/api\/v1$/, '')}${next}`) : ''
  }
  if (url) {
    incomplete = `catalogue pagination stopped at the ${OPENROUTER_MAX_PAGES}-page bound with pages remaining`
  }
  if (models.length > 0) {
    const clean = models.filter(m => {
      const verdict = canonicalWireModelId(`openrouter/${m.id}`)
      return verdict.ok && verdict.healed !== true
    })
    if (clean.length === 0) {
      throw new Error(
        `the models endpoint answered a non-catalogue view (0/${models.length} listed ids are dispatchable) — a compatibility surface, not the live catalogue`,
      )
    }
  }
  return { models, fetchedAtMs: Date.now(), ...(incomplete ? { incomplete } : {}) }
}


const OPENROUTER_CATALOGUE_TTL_MS = 5 * 60_000
const OPENROUTER_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface OpenrouterCatalogueSnapshot {
  keySource: OpenrouterKeySource
  models: OpenrouterLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, OpenrouterCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<OpenrouterCatalogueSnapshot | null>>()

function storeSnapshot(identity: string, snapshot: OpenrouterCatalogueSnapshot): void {
  catalogueCache.set(identity, snapshot)
}

function catalogueIdentity(
  keySource: OpenrouterKeySource,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth || auth.account.keySource !== keySource) return `${keySource}:none`
  return `${keySource}:${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}`
}

export function getCachedOpenrouterCatalogue(
  keySource: OpenrouterKeySource,
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterCatalogueSnapshot | null {
  return catalogueCache.get(catalogueIdentity(keySource, env)) ?? null
}

export function refreshOpenrouterCatalogue(
  keySource: OpenrouterKeySource,
  opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<OpenrouterCatalogueSnapshot | null> {
  const now = opts?.now ?? Date.now
  const identity = catalogueIdentity(keySource, opts?.env)
  const cached = catalogueCache.get(identity)
  if (!catalogueTrafficVerdict('openrouter', opts?.env ?? process.env).allowed) {
    return Promise.resolve(cached ?? null)
  }
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window =
    cached && cached.models.length === 0 && cached.lastError
      ? OPENROUTER_CATALOGUE_FAILURE_RETRY_MS
      : OPENROUTER_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) {
    return Promise.resolve(cached)
  }
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<OpenrouterCatalogueSnapshot | null> => {
    try {
      const auth = resolveOpenrouterRequestAuth(opts?.env ?? process.env)
      if (!auth || auth.account.keySource !== keySource) {
        const snapshot: OpenrouterCatalogueSnapshot = {
          keySource,
          models: cached?.models ?? [],
          fetchedAtMs: cached?.fetchedAtMs ?? 0,
          lastAttemptAtMs: now(),
          lastError: 'account-source-unavailable',
        }
        storeSnapshot(identity, snapshot)
        return snapshot
      }
      const result = await fetchOpenrouterLiveModels({
        baseUrl: auth.baseUrl,
        headers: auth.headers,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: OpenrouterCatalogueSnapshot = {
        keySource,
        models: result.models,
        fetchedAtMs: result.fetchedAtMs,
        ...(result.incomplete ? { lastError: result.incomplete } : {}),
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: OpenrouterCatalogueSnapshot = {
        keySource,
        models: cached?.models ?? [],
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      bumpCatalogueEpoch()
    }
  })()
  catalogueInFlight.set(identity, work)
  return work
}


export type OpenrouterDisabledWhy =
  | 'no-account'
  | 'auth-invalid'
  | 'catalogue-pending'
  | 'catalogue-error'
  | 'no-models'
  | 'traffic-off'

export type OpenrouterAvailability =
  | { state: 'disabled'; why: OpenrouterDisabledWhy; reason: string }
  | {
      state: 'ready'
      ids: string[]
      modelCount: number
      source: string
      keySource: OpenrouterKeySource
      fetchedAtMs: number
    }

export function getOpenrouterAvailability(
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterAvailability {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) {
    return {
      state: 'disabled',
      why: 'no-account',
      reason: `${connectToBrowseReason('openrouter')} — /logins connects`,
    }
  }
  const keySource = auth.account.keySource
  const snapshot = getCachedOpenrouterCatalogue(keySource)
  const verdict = catalogueTrafficVerdict('openrouter', env)
  if (!verdict.allowed && (!snapshot || snapshot.models.length === 0)) {
    return { state: 'disabled', why: 'traffic-off', reason: verdict.reason }
  }
  if (!snapshot) {
    void refreshOpenrouterCatalogue(keySource).catch(() => {})
    return {
      state: 'disabled',
      why: 'catalogue-pending',
      reason: 'live catalogue not fetched yet — retry shortly',
    }
  }
  if (snapshot.models.length === 0 && snapshot.lastError) {
    void refreshOpenrouterCatalogue(keySource).catch(() => {})
    if (/refused the credential/.test(snapshot.lastError)) {
      return {
        state: 'disabled',
        why: 'auth-invalid',
        reason: 'the OpenRouter credential was refused — /logins re-connects',
      }
    }
    const overrideBase = env['MERCURY_OPENROUTER_API_BASE']?.trim()
    return {
      state: 'disabled',
      why: 'catalogue-error',
      reason: `live catalogue unreachable (${snapshot.lastError})${overrideBase ? ` · base override ${overrideBase}` : ''}`,
    }
  }
  if (snapshot.models.length === 0) {
    return {
      state: 'disabled',
      why: 'no-models',
      reason: 'the live catalogue listed no models for this credential',
    }
  }
  const overrideBase = env['MERCURY_OPENROUTER_API_BASE']?.trim()
  return {
    state: 'ready',
    ids: snapshot.models.map(m => m.id),
    modelCount: snapshot.models.length,
    source: overrideBase
      ? `${auth.account.label} · base override ${overrideBase}`
      : auth.account.label,
    keySource,
    fetchedAtMs: snapshot.fetchedAtMs,
  }
}


export function openrouterModelsForVendor(
  vendor: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterLiveModel[] {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return []
  const snapshot = getCachedOpenrouterCatalogue(auth.account.keySource)
  if (!snapshot) return []
  const prefix = `${vendor.toLowerCase().replace(/\/+$/, '')}/`
  return snapshot.models.filter(m => m.id.toLowerCase().startsWith(prefix))
}


export function openrouterListedModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterLiveModel | undefined {
  if (declaredRouteOf(model) !== 'openrouter') return undefined
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return undefined
  const snapshot = getCachedOpenrouterCatalogue(auth.account.keySource, env)
  if (!snapshot || snapshot.models.length === 0) return undefined
  const verdict = canonicalWireModelId(model)
  const slug = (verdict.ok ? verdict.wireId : qualifiedWireId(model)).toLowerCase()
  return snapshot.models.find(m => m.id.toLowerCase() === slug)
}

export function openrouterContextWindowFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { window: number; source: 'live-current' } | undefined {
  const listed = openrouterListedModel(model, env)
  return listed?.contextLength !== undefined && listed.contextLength > 0
    ? { window: listed.contextLength, source: 'live-current' }
    : undefined
}

export function openrouterMaxCompletionTokensFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const listed = openrouterListedModel(model, env)
  return listed?.maxCompletionTokens !== undefined && listed.maxCompletionTokens > 0
    ? listed.maxCompletionTokens
    : undefined
}

export function openrouterEffortVocabularyFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const listed = openrouterListedModel(model, env)
  if (!listed) return []
  const stated = listed.reasoning?.supportedEfforts
  if (stated !== undefined) {
    return stated.filter(level => OPENROUTER_REASONING_EFFORTS.includes(level))
  }
  return listed.supportedParameters?.includes('reasoning') ? OPENROUTER_REASONING_EFFORTS : []
}


export const OPENROUTER_MODEL_GROUP = 'Mercury — OpenRouter models'
export const OPENROUTER_CONNECT_OPTION_VALUE = '__mercury_openrouter_connect__'

const OPENROUTER_PICKER_ROW_BOUND = 24

export function openrouterDispatchReady(
  route: (model: string) => string | null = declaredRouteOf,
): boolean {
  return route('openrouter/auto') === 'openrouter'
}

export function getOpenrouterModelOptions(
  env: NodeJS.ProcessEnv = process.env,
): ModelOption[] {
  const availability = getOpenrouterAvailability(env)
  if (availability.state === 'disabled') {
    const signIn = availability.why === 'no-account' || availability.why === 'auth-invalid'
    return [
      {
        value: OPENROUTER_CONNECT_OPTION_VALUE,
        label: signIn
          ? 'OpenRouter — sign in'
          : availability.why === 'traffic-off'
            ? 'OpenRouter — catalogue off'
            : availability.why === 'catalogue-error'
              ? 'OpenRouter — catalogue unreachable'
              : availability.why === 'no-models'
                ? 'OpenRouter — no models listed'
                : 'OpenRouter — connecting…',
        description: signIn
          ? `${connectToBrowseReason('openrouter')} — ↵ runs /logins`
          : availability.why === 'traffic-off'
            ? availability.reason
            : `rows appear when the live catalogue lands (${availability.reason}) — ↵ retries now`,
        descriptionForModel:
          availability.why === 'traffic-off'
            ? `Catalogue traffic is switched off (${availability.reason}); no model-list request is made and the live-only OpenRouter list stays empty until it is re-enabled.`
            : 'The OpenRouter group is not connected — no catalogue is fetched while signed out; the operator signs in with /logins and the model list then derives live from the OpenRouter catalogue.',
        group: OPENROUTER_MODEL_GROUP,
      },
    ]
  }
  const wireReady = openrouterDispatchReady()
  const pendingReason = 'dispatch wire pending — the provider-wire fold routes OpenRouter turns'
  const rows: ModelOption[] = []
  const snapshot = getCachedOpenrouterCatalogue(availability.keySource, env)
  const models = snapshot?.models ?? []
  if (snapshot?.lastError && snapshot.fetchedAtMs > 0) {
    const ageMin = Math.max(1, Math.round((Date.now() - snapshot.fetchedAtMs) / 60_000))
    rows.push({
      value: OPENROUTER_CONNECT_OPTION_VALUE,
      label: `OpenRouter — catalogue stale (${ageMin}m)`,
      description: `last refresh failed: ${snapshot.lastError} — ↵ retries now`,
      descriptionForModel: `The OpenRouter rows derive from a snapshot ${ageMin} minute(s) old; the last live refresh failed (${snapshot.lastError}).`,
      group: OPENROUTER_MODEL_GROUP,
    })
  }
  const listedIds = new Set(models.map(m => m.id))
  const byId = new Map(models.map(m => [m.id, m]))
  const emitted = new Set<string>()
  for (const model of models.slice(0, OPENROUTER_PICKER_ROW_BOUND)) {
    const rawVerdict = canonicalWireModelId(`openrouter/${model.id}`)
    const rowClean = rawVerdict.ok && rawVerdict.healed !== true
    const healed = rowClean ? model.id : healListedCatalogueRowId(model.id, listedIds)
    if (healed !== undefined && healed !== model.id) {
      if (emitted.has(healed)) continue
      const twin = byId.get(healed) ?? model
      emitted.add(healed)
      rows.push({
        value: `openrouter/${healed}`,
        label: twin.name ?? healed,
        description: '',
        descriptionForModel: `${twin.name ?? healed} (${healed}) — served through the connected ${availability.source}, live-listed by the OpenRouter catalogue (most-popular order); persisted as openrouter/${healed}.`,
        group: OPENROUTER_MODEL_GROUP,
        ...(wireReady ? {} : { unavailable: pendingReason }),
        ...(twin.contextLength !== undefined ? { statedContextWindow: twin.contextLength } : {}),
      })
      continue
    }
    if (healed === undefined) {
      rows.push({
        value: `openrouter/${model.id}`,
        label: model.name ?? model.id,
        description: '',
        descriptionForModel: `${model.name ?? model.id} (${model.id}) — listed by the connected ${availability.source} but not dispatchable as spelled.`,
        group: OPENROUTER_MODEL_GROUP,
        unavailable: !rawVerdict.ok
          ? 'not a dispatchable id — the row carries display words, not a catalogue id'
          : 'not a dispatchable id — the row carries Mercury display dressing, not a catalogue id',
      })
      continue
    }
    if (emitted.has(model.id)) continue
    emitted.add(model.id)
    rows.push({
      value: `openrouter/${model.id}`,
      label: model.name ?? model.id,
      description: '',
      descriptionForModel: `${model.name ?? model.id} (${model.id}) — served through the connected ${availability.source}, live-listed by the OpenRouter catalogue (most-popular order); persisted as openrouter/${model.id}.`,
      group: OPENROUTER_MODEL_GROUP,
      ...(wireReady ? {} : { unavailable: pendingReason }),
      ...(model.contextLength !== undefined ? { statedContextWindow: model.contextLength } : {}),
    })
  }
  if (availability.modelCount > OPENROUTER_PICKER_ROW_BOUND) {
    rows.push({
      value: OPENROUTER_CONNECT_OPTION_VALUE,
      label: `OpenRouter — ${availability.modelCount} models live`,
      description: `top ${OPENROUTER_PICKER_ROW_BOUND} shown (the vendor's most-popular order) · the full catalogue is served live`,
      descriptionForModel: `The connected OpenRouter credential serves ${availability.modelCount} live models; the picker renders the top ${OPENROUTER_PICKER_ROW_BOUND} by the vendor's own most-popular ranking.`,
      group: OPENROUTER_MODEL_GROUP,
      unavailable: 'a summary row — pick a listed model',
    })
  }
  return rows
}

export function __resetOpenrouterCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
