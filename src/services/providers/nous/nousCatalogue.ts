import { isDeepStrictEqual } from 'node:util'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import type { ModelOption } from '../../../utils/model/modelOptions.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { canonicalWireModelId, declaredRouteOf, healListedCatalogueRowId, qualifiedWireId } from '../routeLaw.js'
import { OPENROUTER_REASONING_EFFORTS } from '../openaicompat/compatWire.js'
import { nousApiBase, nousModelsUrl, resolveNousAccount, resolveNousApiKey } from './nousAccounts.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const NOUS_CATALOGUE_TTL_MS = 5 * 60_000
const NOUS_CATALOGUE_FAILURE_RETRY_MS = 10_000

export const NOUS_MODEL_PREFIX = 'nous/'

export interface NousLiveModel {
  id: string
  name?: string
  description?: string
  contextLength?: number
  pricing?: { prompt?: string; completion?: string; request?: string; inputCacheRead?: string; inputCacheWrite?: string }
  supportedParameters?: readonly string[]
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
  maxCompletionTokens?: number
  expirationDate?: string
  createdAtS?: number
  reasoning?: { supportedEfforts?: readonly string[]; defaultEffort?: string; mandatory?: boolean }
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
function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

export function decodeNousModel(raw: unknown): NousLiveModel | undefined {
  const r = record(raw)
  const id = str(r?.id)
  if (!r || !id) return undefined
  const architecture = record(r.architecture)
  const pricing = record(r.pricing)
  const topProvider = record(r.top_provider)
  const reasoningRaw = record(r.reasoning)
  const decodedPricing = pricing
    ? {
        ...(str(pricing.prompt) !== undefined ? { prompt: str(pricing.prompt)! } : {}),
        ...(str(pricing.completion) !== undefined ? { completion: str(pricing.completion)! } : {}),
        ...(str(pricing.request) !== undefined ? { request: str(pricing.request)! } : {}),
        ...(str(pricing.input_cache_read) !== undefined ? { inputCacheRead: str(pricing.input_cache_read)! } : {}),
        ...(str(pricing.input_cache_write) !== undefined ? { inputCacheWrite: str(pricing.input_cache_write)! } : {}),
      }
    : undefined
  const reasoning = reasoningRaw
    ? {
        ...(strArray(reasoningRaw.supported_efforts) !== undefined ? { supportedEfforts: strArray(reasoningRaw.supported_efforts)! } : {}),
        ...(str(reasoningRaw.default_effort) !== undefined ? { defaultEffort: str(reasoningRaw.default_effort)! } : {}),
        ...(typeof reasoningRaw.mandatory === 'boolean' ? { mandatory: reasoningRaw.mandatory } : {}),
      }
    : undefined
  return {
    id: id.trim(),
    ...(str(r.name) !== undefined ? { name: str(r.name)! } : {}),
    ...(str(r.description) !== undefined ? { description: str(r.description)! } : {}),
    ...(num(r.context_length) !== undefined ? { contextLength: num(r.context_length)! } : {}),
    ...(decodedPricing && Object.keys(decodedPricing).length > 0 ? { pricing: decodedPricing } : {}),
    ...(strArray(r.supported_parameters) !== undefined ? { supportedParameters: strArray(r.supported_parameters)! } : {}),
    ...(strArray(architecture?.input_modalities) !== undefined ? { inputModalities: strArray(architecture?.input_modalities)! } : {}),
    ...(strArray(architecture?.output_modalities) !== undefined ? { outputModalities: strArray(architecture?.output_modalities)! } : {}),
    ...(num(topProvider?.max_completion_tokens) !== undefined ? { maxCompletionTokens: num(topProvider?.max_completion_tokens)! } : {}),
    ...(str(r.expiration_date) !== undefined ? { expirationDate: str(r.expiration_date)! } : {}),
    ...(num(r.created) !== undefined ? { createdAtS: num(r.created)! } : {}),
    ...(reasoning && Object.keys(reasoning).length > 0 ? { reasoning } : {}),
  }
}

export async function fetchNousLiveModels(opts: {
  baseUrl: string
  key: string
  fetchImpl?: typeof fetch
}): Promise<{ models: NousLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'nous', CATALOGUE_FETCH_TIMEOUT_MS, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? `Nous Portal models endpoint refused the credential (HTTP ${response.status})`
        : `Nous Portal models endpoint returned HTTP ${response.status}`,
    )
  }
  const parsed = await catalogueBodyJson(response)
  const data = record(parsed)?.data
  if (!Array.isArray(data)) throw new Error('Nous Portal models endpoint returned a malformed catalogue')
  const models = data.map(decodeNousModel).filter((model): model is NousLiveModel => model !== undefined)
  if (data.length > 0 && models.length === 0) {
    throw new Error('the models endpoint answered a non-catalogue view (no listed row carries a model id)')
  }
  if (models.length > 0 && !models.some(m => canonicalWireModelId(`${NOUS_MODEL_PREFIX}${m.id}`).ok)) {
    throw new Error(`the models endpoint answered a non-catalogue view (0/${models.length} listed ids are dispatchable) — a compatibility surface, not the live catalogue`)
  }
  return { models, fetchedAtMs: Date.now() }
}

export interface NousCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: NousLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, NousCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<NousCatalogueSnapshot | null>>()

function catalogueIdentity(env: NodeJS.ProcessEnv): string {
  const key = resolveNousApiKey(env)
  if (!key) return 'none'
  return `${key.source}:${credentialFingerprint(key.key)}:${nousApiBase(env)}`
}

export function getCachedNousCatalogue(env: NodeJS.ProcessEnv = process.env): NousCatalogueSnapshot | null {
  if (!resolveNousApiKey(env)) return null
  return catalogueCache.get(catalogueIdentity(env)) ?? null
}

export function refreshNousCatalogue(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<NousCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveNousApiKey(env)
  const identity = catalogueIdentity(env)
  const cached = key ? catalogueCache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('nous', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window = cached && cached.models.length === 0 && cached.lastError ? NOUS_CATALOGUE_FAILURE_RETRY_MS : NOUS_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<NousCatalogueSnapshot | null> => {
    try {
      const result = await fetchNousLiveModels({ baseUrl: nousApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: NousCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      catalogueCache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: NousCatalogueSnapshot = {
        keySource: key.source,
        models: cached?.models ?? [],
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
      catalogueCache.set(identity, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      const settled = catalogueCache.get(identity)
      if (settled?.lastError !== cached?.lastError || !isDeepStrictEqual(settled?.models, cached?.models)) bumpCatalogueEpoch()
    }
  })()
  catalogueInFlight.set(identity, work)
  return work
}

export function kickNousCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('nous', env).allowed) return false
  const snapshot = getCachedNousCatalogue(env)
  if (snapshot && snapshot.fetchedAtMs > 0) return false
  void refreshNousCatalogue(opts).catch(() => null)
  return true
}

export type NousDisabledWhy = 'no-account' | 'auth-invalid' | 'catalogue-pending' | 'catalogue-error' | 'no-models' | 'traffic-off'

export type NousAvailability =
  | { state: 'disabled'; why: NousDisabledWhy; reason: string }
  | { state: 'ready'; ids: string[]; modelCount: number; source: string; keySource: 'env' | 'stored'; fetchedAtMs: number }

export function getNousAvailability(env: NodeJS.ProcessEnv = process.env): NousAvailability {
  const account = resolveNousAccount(env)
  if (!account) return { state: 'disabled', why: 'no-account', reason: `${connectToBrowseReason('nous')} — /logins nous connects` }
  const snapshot = getCachedNousCatalogue(env)
  const verdict = catalogueTrafficVerdict('nous', env)
  if (!verdict.allowed && (!snapshot || snapshot.models.length === 0)) return { state: 'disabled', why: 'traffic-off', reason: verdict.reason }
  if (!snapshot) {
    void refreshNousCatalogue({ env }).catch(() => {})
    return { state: 'disabled', why: 'catalogue-pending', reason: 'live catalogue not fetched yet — retry shortly' }
  }
  if (snapshot.models.length === 0 && snapshot.lastError) {
    void refreshNousCatalogue({ env }).catch(() => {})
    if (/refused the credential/.test(snapshot.lastError)) {
      return { state: 'disabled', why: 'auth-invalid', reason: 'the Nous Portal key was refused — /logins nous stores another' }
    }
    const overrideBase = env['MERCURY_NOUS_API_BASE']?.trim()
    return { state: 'disabled', why: 'catalogue-error', reason: `live catalogue unreachable (${snapshot.lastError})${overrideBase ? ` · base override ${overrideBase}` : ''}` }
  }
  if (snapshot.models.length === 0) return { state: 'disabled', why: 'no-models', reason: 'the live catalogue listed no models for this key' }
  const overrideBase = env['MERCURY_NOUS_API_BASE']?.trim()
  return {
    state: 'ready',
    ids: snapshot.models.map(m => m.id),
    modelCount: snapshot.models.length,
    source: overrideBase ? `${account.label} · base override ${overrideBase}` : account.label,
    keySource: account.keySource,
    fetchedAtMs: snapshot.fetchedAtMs,
  }
}

export function nousListedModel(model: string, env: NodeJS.ProcessEnv = process.env): NousLiveModel | undefined {
  if (declaredRouteOf(model) !== 'nous') return undefined
  const snapshot = getCachedNousCatalogue(env)
  if (!snapshot || snapshot.models.length === 0) return undefined
  const verdict = canonicalWireModelId(model)
  const slug = (verdict.ok ? verdict.wireId : qualifiedWireId(model)).toLowerCase()
  return snapshot.models.find(m => m.id.toLowerCase() === slug)
}

export function nousContextWindowFor(model: string, env: NodeJS.ProcessEnv = process.env): { window: number; source: 'live-current' } | undefined {
  const listed = nousListedModel(model, env)
  return listed?.contextLength !== undefined && listed.contextLength > 0 ? { window: listed.contextLength, source: 'live-current' } : undefined
}

export function nousMaxCompletionTokensFor(model: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const listed = nousListedModel(model, env)
  return listed?.maxCompletionTokens !== undefined && listed.maxCompletionTokens > 0 ? listed.maxCompletionTokens : undefined
}

export function nousEffortVocabularyFor(model: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const listed = nousListedModel(model, env)
  if (!listed) return []
  const stated = listed.reasoning?.supportedEfforts
  if (stated !== undefined) return stated.filter(level => OPENROUTER_REASONING_EFFORTS.includes(level))
  return listed.supportedParameters?.includes('reasoning') ? OPENROUTER_REASONING_EFFORTS : []
}

export function nousDeclaresTools(model: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const listed = nousListedModel(model, env)
  if (!listed?.supportedParameters) return undefined
  return listed.supportedParameters.includes('tools')
}

export function nousWireModelId(modelId: string, env: NodeJS.ProcessEnv = process.env): string {
  const slug = qualifiedWireId(modelId)
  const snapshot = getCachedNousCatalogue(env)
  if (!snapshot || snapshot.models.length === 0) return slug
  const listed = new Map(snapshot.models.map(m => [m.id.toLowerCase(), m.id]))
  const direct = listed.get(slug.trim().toLowerCase())
  if (direct !== undefined) return direct
  const untagged = slug.replace(/\[(?:[0-9]+m|served)\]$/i, '')
  const found = untagged !== slug ? listed.get(untagged.trim().toLowerCase()) : undefined
  return found ?? slug
}

export const NOUS_PORTAL_RECOMMENDED: readonly string[] = [
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.5-pro',
  'google/gemini-3.1-pro-preview',
  'deepseek/deepseek-v4-pro',
]

export const NOUS_MODEL_GROUP = 'Mercury — Nous Portal models'
export const NOUS_CONNECT_OPTION_VALUE = '__mercury_nous_connect__'
export const NOUS_EXPAND_OPTION_VALUE = '__mercury_nous_expand__'

const NOUS_PICKER_ROW_BOUND = 24

function headFirst(models: NousLiveModel[]): NousLiveModel[] {
  const byId = new Map(models.map(m => [m.id.toLowerCase(), m]))
  const head = NOUS_PORTAL_RECOMMENDED.map(id => byId.get(id)).filter((m): m is NousLiveModel => m !== undefined)
  const headIds = new Set(head.map(m => m.id))
  const rest = models.filter(m => !headIds.has(m.id))
  const plain = rest.filter(m => !m.id.includes(':'))
  const variants = rest.filter(m => m.id.includes(':'))
  return [...head, ...plain, ...variants]
}

export function getNousModelOptions(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const availability = getNousAvailability(env)
  if (availability.state === 'disabled') {
    const signIn = availability.why === 'no-account' || availability.why === 'auth-invalid'
    return [
      {
        value: NOUS_CONNECT_OPTION_VALUE,
        label: signIn
          ? 'Nous Portal — add a key'
          : availability.why === 'traffic-off'
            ? 'Nous Portal — catalogue off'
            : availability.why === 'catalogue-error'
              ? 'Nous Portal — catalogue unreachable'
              : availability.why === 'no-models'
                ? 'Nous Portal — no models listed'
                : 'Nous Portal — connecting…',
        description: signIn
          ? `${connectToBrowseReason('nous')} — ↵ runs /logins nous`
          : availability.why === 'traffic-off'
            ? availability.reason
            : `rows appear when the live catalogue lands (${availability.reason}) — ↵ retries now`,
        descriptionForModel:
          availability.why === 'traffic-off'
            ? `Catalogue traffic is switched off (${availability.reason}); no model-list request is made and the live-only Nous Portal list stays empty until it is re-enabled.`
            : 'The Nous Portal group is not connected — no catalogue is fetched without a key; the operator stores one with /logins nous and the model list then derives live from the Portal catalogue.',
        group: NOUS_MODEL_GROUP,
      },
    ]
  }
  const rows: ModelOption[] = []
  const snapshot = getCachedNousCatalogue(env)
  const models = snapshot?.models ?? []
  if (snapshot?.lastError && snapshot.fetchedAtMs > 0) {
    const ageMin = Math.max(1, Math.round((Date.now() - snapshot.fetchedAtMs) / 60_000))
    rows.push({
      value: NOUS_CONNECT_OPTION_VALUE,
      label: `Nous Portal — catalogue stale (${ageMin}m)`,
      description: `last refresh failed: ${snapshot.lastError} — ↵ retries now`,
      descriptionForModel: `The Nous Portal rows derive from a snapshot ${ageMin} minute(s) old; the last live refresh failed (${snapshot.lastError}).`,
      group: NOUS_MODEL_GROUP,
    })
  }
  rows.push(...nousCatalogueRows(headFirst(models), availability.source, NOUS_PICKER_ROW_BOUND))
  if (availability.modelCount > NOUS_PICKER_ROW_BOUND) {
    rows.push({
      value: NOUS_EXPAND_OPTION_VALUE,
      label: `Nous Portal — ${availability.modelCount} models live`,
      description: `↵ expand · ${availability.modelCount} live · type to filter`,
      descriptionForModel: `The Nous Portal key serves ${availability.modelCount} live models; the picker renders the Portal's recommended agentic rows first, then the catalogue's own order, up to ${NOUS_PICKER_ROW_BOUND} rows; this row expands the group to the full list behind a filter — any listed id also dispatches when typed as nous/<vendor>/<model>.`,
      group: NOUS_MODEL_GROUP,
      catalogueDoor: { family: 'Nous Portal', total: availability.modelCount },
    })
  }
  return rows
}

export function getNousFullModelOptions(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const availability = getNousAvailability(env)
  if (availability.state !== 'ready') return []
  const models = getCachedNousCatalogue(env)?.models ?? []
  return nousCatalogueRows(headFirst(models), availability.source, models.length)
}

function nousCatalogueRows(models: NousLiveModel[], source: string, bound: number): ModelOption[] {
  const rows: ModelOption[] = []
  const listedIds = new Set(models.map(m => m.id))
  const byId = new Map(models.map(m => [m.id, m]))
  const emitted = new Set<string>()
  for (const model of models.slice(0, bound)) {
    const rawVerdict = canonicalWireModelId(`${NOUS_MODEL_PREFIX}${model.id}`)
    const rowClean = rawVerdict.ok && rawVerdict.healed !== true
    const healed = rowClean ? model.id : healListedCatalogueRowId(model.id, listedIds)
    if (healed === undefined) {
      rows.push({
        value: `${NOUS_MODEL_PREFIX}${model.id}`,
        label: model.name ?? model.id,
        description: '',
        descriptionForModel: `${model.name ?? model.id} (${model.id}) — listed by the ${source} but not dispatchable as spelled.`,
        group: NOUS_MODEL_GROUP,
        unavailable: 'not a dispatchable id — the row carries display words, not a catalogue id',
      })
      continue
    }
    if (emitted.has(healed)) continue
    emitted.add(healed)
    const row = byId.get(healed) ?? model
    rows.push({
      value: `${NOUS_MODEL_PREFIX}${healed}`,
      label: row.name ?? healed,
      description: '',
      descriptionForModel: `${row.name ?? healed} (${healed}) — served through the ${source}, live-listed by the Nous Portal catalogue; persisted as ${NOUS_MODEL_PREFIX}${healed}.`,
      group: NOUS_MODEL_GROUP,
      ...(row.contextLength !== undefined ? { statedContextWindow: row.contextLength } : {}),
    })
  }
  return rows
}

export function nousCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const availability = getNousAvailability(env)
  return availability.state === 'ready' ? `${availability.modelCount} ${availability.modelCount === 1 ? 'model' : 'models'} live` : undefined
}

export function __resetNousCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
