import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { metaApiBase, resolveMetaApiKey } from './metaAccounts.js'
import { isMetaChatModelId, isMetaContributorModel, metaDisplayName, metaDisplayPin } from './metaPins.js'

export interface MetaLiveModel {
  id: string
  created: number
  ownedBy?: string
}

export function decodeMetaModel(raw: unknown): MetaLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isMetaChatModelId(row.id)) return undefined
  if (typeof row.created !== 'number' || !Number.isFinite(row.created) || row.created < 0) return undefined
  return { id: row.id.trim(), created: row.created, ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class MetaCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Meta models endpoint refused the credential (HTTP ${status})` : `Meta models endpoint returned HTTP ${status}`)
  }
}

export async function fetchMetaLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: MetaLiveModel[]; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'meta', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new MetaCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('Meta models endpoint returned no data array')
  const seen = new Set<string>()
  const models: MetaLiveModel[] = []
  for (const raw of parsed.data) {
    const model = decodeMetaModel(raw)
    if (!model || seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  models.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
  return { models, fetchedAtMs: Date.now() }
}

export interface MetaCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: MetaLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, MetaCatalogueSnapshot>()
const inFlight = new Map<string, Promise<MetaCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveMetaApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${metaApiBase(env)}` : 'none'
}

export function getCachedMetaCatalogue(env: NodeJS.ProcessEnv = process.env): MetaCatalogueSnapshot | null {
  return resolveMetaApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<MetaCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedMetaCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.map(row => row.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function refreshMetaCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<MetaCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveMetaApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('meta', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < (cached.lastError ? 10_000 : 300_000)) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<MetaCatalogueSnapshot | null> => {
    try {
      const result = await fetchMetaLiveModels({ baseUrl: metaApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: MetaCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof MetaCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: MetaCatalogueSnapshot = {
        keySource: key.source, models: refused ? [] : cached?.models ?? [], fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(), lastError: (error instanceof Error ? error.message : String(error)).split(key.key).join('[redacted]'),
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

export function kickMetaCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('meta', env).allowed) return false
  const snapshot = getCachedMetaCatalogue(env)
  if (snapshot && !snapshot.lastError) return false
  void refreshMetaCatalogue(opts).catch(() => null)
  return true
}

export interface MetaCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
export type MetaCatalogueSource = { kind: 'live'; count: number; fetchedAtMs: number } | { kind: 'unread' }

export function metaCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: MetaCatalogueRow[]; source: MetaCatalogueSource } {
  const snapshot = getCachedMetaCatalogue(env)
  if (!snapshot?.fetchedAtMs) return { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = metaDisplayPin(model.id)
    return { id: model.id, displayName: metaDisplayName(model.id), observedAt: pin?.observedAt ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(pin ? { contextWindow: pin.contextWindow } : {}), listedLive: true }
  })
  rows.sort((a, b) => Number(isMetaContributorModel(a.id)) - Number(isMetaContributorModel(b.id)))
  return { rows, source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function newestMetaModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return metaCatalogueRows(env).rows.find(row => !isMetaContributorModel(row.id))?.id
}

export function metaCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedMetaCatalogue(env)
  if (snapshot?.lastError) return snapshot.lastError
  const { source } = metaCatalogueRows(env)
  return source.kind === 'live' ? `${source.count} ${source.count === 1 ? 'model' : 'models'} live` : undefined
}

export function __resetMetaCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
