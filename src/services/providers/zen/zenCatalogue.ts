import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { resolveZenApiKey, zenApiBase } from './zenAccounts.js'
import { zenDisplayName, zenDisplayPin, zenServedShapeOf, type ZenServedShape, type ZenWireShape } from './zenPins.js'

export interface ZenLiveModel {
  id: string
  created: number
  shape: ZenServedShape
  ownedBy?: string
}

export function decodeZenModel(raw: unknown): ZenLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id.trim() === '' || row.id.includes('/')) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  const id = row.id.trim()
  return { id, created, shape: zenServedShapeOf(id), ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class ZenCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `OpenCode Zen models endpoint refused the credential (HTTP ${status})` : `OpenCode Zen models endpoint returned HTTP ${status}`)
  }
}

export async function fetchZenLiveModels(opts: { baseUrl: string; key?: string; fetchImpl?: typeof fetch }): Promise<{ models: ZenLiveModel[]; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'zen', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': getProductUserAgent(), ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new ZenCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('OpenCode Zen models endpoint returned no data array')
  const seen = new Set<string>()
  const models: ZenLiveModel[] = []
  for (const raw of parsed.data) {
    const model = decodeZenModel(raw)
    if (!model || seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  return { models, fetchedAtMs: Date.now() }
}

export interface ZenCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: ZenLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, ZenCatalogueSnapshot>()
const inFlight = new Map<string, Promise<ZenCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveZenApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${zenApiBase(env)}` : 'none'
}

export function getCachedZenCatalogue(env: NodeJS.ProcessEnv = process.env): ZenCatalogueSnapshot | null {
  return resolveZenApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

export function dispatchableZenModels(snapshot: ZenCatalogueSnapshot | null): ZenLiveModel[] {
  return (snapshot?.models ?? []).filter(model => model.shape === 'chat' || model.shape === 'responses')
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<ZenCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedZenCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(dispatchableZenModels(snapshot).map(row => row.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function refreshZenCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<ZenCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveZenApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('zen', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < (cached.lastError ? 10_000 : 300_000)) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<ZenCatalogueSnapshot | null> => {
    try {
      const result = await fetchZenLiveModels({ baseUrl: zenApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: ZenCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof ZenCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: ZenCatalogueSnapshot = {
        keySource: key.source,
        models: refused ? [] : cached?.models ?? [],
        fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: (error instanceof Error ? error.message : String(error)).split(key.key).join('[redacted]'),
      }
      cache.set(identity, snapshot)
      return snapshot
    } finally {
      inFlight.delete(identity)
      bumpCatalogueEpoch()
    }
  })()
  inFlight.set(identity, work)
  return work
}

export function kickZenCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('zen', env).allowed) return false
  const snapshot = getCachedZenCatalogue(env)
  if (snapshot && !snapshot.lastError) return false
  void refreshZenCatalogue(opts).catch(() => null)
  return true
}

export interface ZenCatalogueRow {
  id: string
  displayName: string
  shape: ZenWireShape
  observedAt: string
  contextWindow?: number
  free: boolean
  listedLive: boolean
}
export type ZenCatalogueSource = { kind: 'live'; count: number; otherShapes: number; fetchedAtMs: number } | { kind: 'unread' }

const SHAPE_ORDER: Record<ZenWireShape, number> = { chat: 0, responses: 1 }

export function zenCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: ZenCatalogueRow[]; source: ZenCatalogueSource } {
  const snapshot = getCachedZenCatalogue(env)
  if (!snapshot?.fetchedAtMs) return { rows: [], source: { kind: 'unread' } }
  const dispatchable = dispatchableZenModels(snapshot)
  const rows = dispatchable.map(model => {
    const pin = zenDisplayPin(model.id)
    const shape = model.shape as ZenWireShape
    return {
      id: model.id,
      displayName: zenDisplayName(model.id),
      shape,
      observedAt: pin ? '' : new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(pin ? { contextWindow: pin.contextWindow } : {}),
      free: pin?.free === true || /-free$/i.test(model.id) || model.id.toLowerCase() === 'big-pickle',
      listedLive: true,
    }
  })
  rows.sort((a, b) => Number(a.free) - Number(b.free) || SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape])
  return { rows, source: { kind: 'live', count: rows.length, otherShapes: snapshot.models.length - dispatchable.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function zenCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedZenCatalogue(env)
  if (snapshot?.lastError) return snapshot.lastError
  const { source } = zenCatalogueRows(env)
  return source.kind === 'live' ? `${source.count} ${source.count === 1 ? 'model' : 'models'} live` : undefined
}

export function __resetZenCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
