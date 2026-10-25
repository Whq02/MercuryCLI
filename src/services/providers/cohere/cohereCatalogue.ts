import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { cohereApiBase, resolveCohereApiKey } from './cohereAccounts.js'
import { COHERE_DISPLAY_PINS, isCohereChatModelId, cohereDisplayName, cohereDisplayPin } from './coherePins.js'

export interface CohereLiveModel {
  id: string
  created: number
  ownedBy?: string
}

export function decodeCohereModel(raw: unknown): CohereLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isCohereChatModelId(row.id)) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  return { id: row.id.trim(), created, ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class CohereCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Cohere models endpoint refused the credential (HTTP ${status})` : `Cohere models endpoint returned HTTP ${status}`)
  }
}

export async function fetchCohereLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: CohereLiveModel[]; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'cohere', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new CohereCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('Cohere models endpoint returned no data array')
  const seen = new Set<string>()
  const models: CohereLiveModel[] = []
  for (const raw of parsed.data) {
    const model = decodeCohereModel(raw)
    if (!model || seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = COHERE_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase())
    return index === -1 ? COHERE_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  return { models, fetchedAtMs: Date.now() }
}

export interface CohereCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: CohereLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, CohereCatalogueSnapshot>()
const inFlight = new Map<string, Promise<CohereCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveCohereApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${cohereApiBase(env)}` : 'none'
}

export function getCachedCohereCatalogue(env: NodeJS.ProcessEnv = process.env): CohereCatalogueSnapshot | null {
  return resolveCohereApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<CohereCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedCohereCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.map(row => row.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function cohereListedModel(snapshot: CohereCatalogueSnapshot | null, id: string): CohereLiveModel | undefined {
  const wanted = id.trim().toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshCohereCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<CohereCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveCohereApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('cohere', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < 300_000) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<CohereCatalogueSnapshot | null> => {
    try {
      const result = await fetchCohereLiveModels({ baseUrl: cohereApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: CohereCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof CohereCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: CohereCatalogueSnapshot = {
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

export function kickCohereCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('cohere', env).allowed) return false
  const snapshot = getCachedCohereCatalogue(env)
  if (snapshot && !snapshot.lastError) return false
  void refreshCohereCatalogue(opts).catch(() => null)
  return true
}

export interface CohereCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
export type CohereCatalogueSource = { kind: 'live'; count: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

export function coherePinRows(): CohereCatalogueRow[] {
  return COHERE_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName, observedAt: pin.observedAt, contextWindow: pin.contextWindow, listedLive: false }))
}

export function cohereCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: CohereCatalogueRow[]; source: CohereCatalogueSource } {
  const snapshot = getCachedCohereCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: coherePinRows(), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = cohereDisplayPin(model.id)
    return { id: model.id, displayName: cohereDisplayName(model.id), observedAt: pin?.observedAt ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(pin ? { contextWindow: pin.contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function newestCohereModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return cohereCatalogueRows(env).rows[0]?.id
}

export function cohereCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedCohereCatalogue(env)
  const { source } = cohereCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no chat models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} ${source.count === 1 ? 'model' : 'models'} live` : undefined
}

export function cohereModelFacts(id: string): { contextWindow?: number; outputMax?: number; reasoning?: boolean; images?: boolean; tools?: boolean; efforts: readonly string[] } {
  const pin = cohereDisplayPin(id)
  return {
    ...(pin ? { contextWindow: pin.contextWindow, outputMax: pin.outputMax, reasoning: pin.reasoning, images: pin.images, tools: pin.tools } : {}),
    efforts: pin?.reasoning === true ? pin.efforts : [],
  }
}

export function __resetCohereCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
