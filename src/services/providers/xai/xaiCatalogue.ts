import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { xaiApiBase, resolveXaiApiKey } from './xaiAccounts.js'
import { isXaiChatModelId, xaiDisplayPin, xaiDisplayName, type XaiDisplayPin } from './xaiPins.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const XAI_CATALOGUE_TTL_MS = 5 * 60_000
const XAI_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface XaiLiveModel {
  id: string
  ownedBy?: string
  displayName?: string
  created?: number
  contextWindow?: number
  aliases?: string[]
  efforts?: string[]
  defaultEffort?: string
}
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

export function decodeXaiModel(raw: unknown): XaiLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id || !isXaiChatModelId(id)) return undefined
  if (Array.isArray(r.output_modalities) && !r.output_modalities.includes('text')) return undefined
  if (r.image_price !== undefined && r.image_price !== null) return undefined
  const caps = typeof r.capabilities === 'object' && r.capabilities !== null ? r.capabilities as Record<string, unknown> : undefined
  const efforts = Array.isArray(caps?.reasoning_effort) ? caps.reasoning_effort.filter((v): v is string => typeof v === 'string') : undefined
  return {
    id,
    ...(str(r.owned_by) ? { ownedBy: str(r.owned_by) } : {}),
    ...(str(r.display_name) ? { displayName: str(r.display_name) } : {}),
    ...(positive(r.created) ? { created: positive(r.created) } : {}),
    ...(positive(r.context_length) ? { contextWindow: positive(r.context_length) } : {}),
    ...(Array.isArray(r.aliases) ? { aliases: r.aliases.filter((v): v is string => typeof v === 'string') } : {}),
    ...(efforts !== undefined ? { efforts } : {}),
    ...(str(caps?.default_reasoning_effort) ? { defaultEffort: str(caps?.default_reasoning_effort) } : {}),
  }
}

export class XaiCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `xAI models endpoint refused the credential (HTTP ${status})` : `xAI models endpoint returned HTTP ${status}`)
  }
}

export async function fetchXaiLiveModels(opts: {
  baseUrl: string
  key: string
  fetchImpl?: typeof fetch
}): Promise<{ models: XaiLiveModel[]; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'xai', CATALOGUE_FETCH_TIMEOUT_MS, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new XaiCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('xAI models endpoint returned no data array')
  const models: XaiLiveModel[] = []
  const taken = new Set<string>()
  for (const raw of parsed.data) {
    const model = decodeXaiModel(raw)
    if (!model || taken.has(model.id.toLowerCase())) continue
    taken.add(model.id.toLowerCase())
    models.push(model)
  }
  models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
  return { models, fetchedAtMs: Date.now() }
}

export interface XaiCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: XaiLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}
const catalogueCache = new Map<string, XaiCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<XaiCatalogueSnapshot | null>>()
function catalogueIdentity(env: NodeJS.ProcessEnv): string {
  const key = resolveXaiApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${xaiApiBase(env)}` : 'none'
}
export function getCachedXaiCatalogue(env: NodeJS.ProcessEnv = process.env): XaiCatalogueSnapshot | null {
  return resolveXaiApiKey(env) ? catalogueCache.get(catalogueIdentity(env)) ?? null : null
}
const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<XaiCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (catalogueCache.size === 0) return EMPTY_LIVE_IDS
  const snapshot = getCachedXaiCatalogue(env)
  if (!snapshot || snapshot.fetchedAtMs === 0) return EMPTY_LIVE_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.map(model => model.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}
export function refreshXaiCatalogue(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<XaiCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveXaiApiKey(env)
  const identity = catalogueIdentity(env)
  const cached = key ? catalogueCache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('xai', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const ttl = cached?.lastError ? XAI_CATALOGUE_FAILURE_RETRY_MS : XAI_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < ttl) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<XaiCatalogueSnapshot | null> => {
    try {
      const result = await fetchXaiLiveModels({ baseUrl: xaiApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: XaiCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      catalogueCache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof XaiCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: XaiCatalogueSnapshot = {
        keySource: key.source, models: refused ? [] : cached?.models ?? [],
        fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0, lastAttemptAtMs: now(),
        lastError: (error instanceof Error ? error.message : String(error)).split(key.key).join('[redacted]'),
      }
      catalogueCache.set(identity, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      bumpCatalogueEpoch()
    }
  })()
  catalogueInFlight.set(identity, work)
  return work
}
export function kickXaiCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('xai', env).allowed) return false
  const cached = getCachedXaiCatalogue(env)
  if (cached && cached.lastError === undefined) return false
  void refreshXaiCatalogue(opts).catch(() => null)
  return true
}
export interface XaiCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
export type XaiCatalogueSource =
  | { kind: 'live'; count: number; fetchedAtMs: number }
  | { kind: 'pin'; observedAt: string }

export function xaiCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: XaiCatalogueRow[]; source: XaiCatalogueSource } {
  const snapshot = getCachedXaiCatalogue(env)
  if (!snapshot || snapshot.fetchedAtMs === 0) return { rows: [], source: { kind: 'pin', observedAt: '' } }
  const rows = snapshot.models.map(model => {
    const pin = xaiDisplayPin(model.id)
    const contextWindow = model.contextWindow ?? pin?.contextWindow
    return { id: model.id, displayName: model.displayName ?? xaiDisplayName(model.id),
      observedAt: pin?.observedAt ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(contextWindow !== undefined ? { contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}
export function xaiCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedXaiCatalogue(env)
  if (snapshot?.lastError) return snapshot.lastError
  const { source } = xaiCatalogueRows(env)
  return source.kind === 'live' ? `${source.count} ${source.count === 1 ? 'model' : 'models'} live` : undefined
}
export function __resetXaiCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}

export function xaiModelFacts(id: string, env: NodeJS.ProcessEnv = process.env): XaiDisplayPin | undefined {
  const lowered = id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  const snapshot = getCachedXaiCatalogue(env)
  const model = snapshot?.models.find(row => row.id.toLowerCase() === lowered || row.aliases?.some(alias => alias.toLowerCase() === lowered))
  const pin = xaiDisplayPin(model?.id ?? lowered)
  if (!model) return pin
  return { ...pin, id: model.id, displayName: model.displayName ?? xaiDisplayName(model.id),
    observedAt: new Date(snapshot!.fetchedAtMs).toISOString().slice(0, 10),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.efforts !== undefined ? { efforts: model.efforts } : {}),
    ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}) }
}
