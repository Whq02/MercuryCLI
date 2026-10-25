import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { fireworksApiBase, resolveFireworksApiKey } from './fireworksAccounts.js'
import { FIREWORKS_DISPLAY_PINS, FIREWORKS_OBSERVED_AT, isFireworksTextModelId, fireworksDisplayName, fireworksDisplayPin, fireworksWireId, fireworksQualifiedId } from './fireworksPins.js'

interface FireworksLiveModel {
  id: string
  created: number
  ownedBy?: string
  contextWindow?: number
  outputMax?: number
}

function decodeFireworksModel(raw: unknown): FireworksLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isFireworksTextModelId(row.id)) return undefined
  if (typeof row.type === 'string' && !['chat', 'text', 'language', 'model'].includes(row.type.toLowerCase())) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  return { id: fireworksWireId(row.id), created, ...(typeof row.context_length === 'number' && Number.isFinite(row.context_length) && row.context_length > 0 ? { contextWindow: row.context_length } : {}), ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class FireworksCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Fireworks models endpoint refused the credential (HTTP ${status})` : `Fireworks models endpoint returned HTTP ${status}`)
  }
}

export async function fetchFireworksLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: FireworksLiveModel[]; otherLines: number; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'fireworks', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new FireworksCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('Fireworks models endpoint returned no data array')
  const seen = new Set<string>()
  const models: FireworksLiveModel[] = []
  let otherLines = 0
  for (const raw of parsed.data) {
    const model = decodeFireworksModel(raw)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = FIREWORKS_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase())
    return index === -1 ? FIREWORKS_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  return { models, otherLines, fetchedAtMs: Date.now() }
}

export interface FireworksCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: FireworksLiveModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, FireworksCatalogueSnapshot>()
const inFlight = new Map<string, Promise<FireworksCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveFireworksApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${fireworksApiBase(env)}` : 'none'
}

export function getCachedFireworksCatalogue(env: NodeJS.ProcessEnv = process.env): FireworksCatalogueSnapshot | null {
  return resolveFireworksApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

export function fireworksListedModel(snapshot: FireworksCatalogueSnapshot | null, id: string): FireworksLiveModel | undefined {
  const wanted = fireworksWireId(id).toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshFireworksCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<FireworksCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveFireworksApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('fireworks', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < (cached.lastError ? 10_000 : 300_000)) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<FireworksCatalogueSnapshot | null> => {
    try {
      const result = await fetchFireworksLiveModels({ baseUrl: fireworksApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: FireworksCatalogueSnapshot = { keySource: key.source, models: result.models, otherLines: result.otherLines, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof FireworksCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: FireworksCatalogueSnapshot = {
        keySource: key.source, models: refused ? [] : cached?.models ?? [], otherLines: cached?.otherLines ?? 0, fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
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

interface FireworksCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
type FireworksCatalogueSource = { kind: 'live'; count: number; otherLines: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

function fireworksPinRows(): FireworksCatalogueRow[] {
  return FIREWORKS_DISPLAY_PINS.map(pin => ({ id: fireworksQualifiedId(pin.id), displayName: pin.displayName, observedAt: pin.observedAt ?? FIREWORKS_OBSERVED_AT, contextWindow: pin.contextWindow, listedLive: false }))
}

export function fireworksCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: FireworksCatalogueRow[]; source: FireworksCatalogueSource } {
  const snapshot = getCachedFireworksCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: fireworksPinRows(), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = fireworksDisplayPin(model.id)
    return { id: fireworksQualifiedId(model.id), displayName: fireworksDisplayName(model.id), observedAt: (pin ? pin.observedAt ?? FIREWORKS_OBSERVED_AT : undefined) ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...((model.contextWindow ?? pin?.contextWindow) !== undefined ? { contextWindow: model.contextWindow ?? pin?.contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function fireworksCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedFireworksCatalogue(env)
  const { source } = fireworksCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list (observed ${FIREWORKS_OBSERVED_AT}) — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no text models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} text ${source.count === 1 ? 'model' : 'models'} live${source.otherLines > 0 ? ` · ${source.otherLines} of other lines not listed` : ''}` : undefined
}

export function fireworksContextWindowFor(model: string): number | undefined {
  return fireworksListedModel(getCachedFireworksCatalogue(), model)?.contextWindow ?? fireworksDisplayPin(model)?.contextWindow
}

export function fireworksOutputMaxFor(model: string): number | undefined {
  return fireworksListedModel(getCachedFireworksCatalogue(), model)?.outputMax ?? fireworksDisplayPin(model)?.outputMax
}

export function __resetFireworksCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
