import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { resolveTogetherApiKey, togetherApiBase } from './togetherAccounts.js'
import { TOGETHER_DISPLAY_PINS, TOGETHER_OBSERVED_AT, togetherDisplayPin, togetherQualifiedId, togetherWireId } from './togetherPins.js'

interface TogetherLiveModel {
  id: string
  type: string
  displayName?: string
  contextLength?: number
  pricing?: { input?: number; output?: number }
}

function decodeTogetherModel(raw: unknown): TogetherLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id.trim() === '') return undefined
  const id = row.id.trim()
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : togetherDisplayPin(id) ? 'chat' : ''
  const context = row.context_length
  const pricing = typeof row.pricing === 'object' && row.pricing !== null ? row.pricing as Record<string, unknown> : undefined
  const price = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return {
    id, type,
    ...(typeof row.display_name === 'string' && row.display_name.trim() !== '' ? { displayName: row.display_name.trim() } : {}),
    ...(typeof context === 'number' && Number.isFinite(context) && context > 0 ? { contextLength: Math.floor(context) } : {}),
    ...(pricing && (price(pricing.input) !== undefined || price(pricing.output) !== undefined)
      ? { pricing: { ...(price(pricing.input) !== undefined ? { input: price(pricing.input)! } : {}), ...(price(pricing.output) !== undefined ? { output: price(pricing.output)! } : {}) } }
      : {}),
  }
}

export class TogetherCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Together AI models endpoint refused the credential (HTTP ${status})` : `Together AI models endpoint returned HTTP ${status}`)
  }
}

export async function fetchTogetherLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: TogetherLiveModel[]; otherKinds: number; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'together', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new TogetherCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response)
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Record<string, unknown> | null)?.data) ? (parsed as Record<string, unknown>).data as unknown[] : undefined
  if (!list) throw new Error('Together AI models endpoint returned neither a model array nor a data array')
  const seen = new Set<string>()
  const models: TogetherLiveModel[] = []
  let otherKinds = 0
  for (const raw of list) {
    const model = decodeTogetherModel(raw)
    if (!model) continue
    if (model.type !== 'chat') { otherKinds++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = TOGETHER_DISPLAY_PINS.findIndex(pin => pin.id.toLowerCase() === id.toLowerCase())
    return index === -1 ? TOGETHER_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || a.id.localeCompare(b.id))
  return { models, otherKinds, fetchedAtMs: Date.now() }
}

export interface TogetherCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: TogetherLiveModel[]
  otherKinds: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, TogetherCatalogueSnapshot>()
const inFlight = new Map<string, Promise<TogetherCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveTogetherApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${togetherApiBase(env)}` : 'none'
}

export function getCachedTogetherCatalogue(env: NodeJS.ProcessEnv = process.env): TogetherCatalogueSnapshot | null {
  return resolveTogetherApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<TogetherCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedTogetherCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.map(row => row.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function togetherListedModel(snapshot: TogetherCatalogueSnapshot | null, id: string): TogetherLiveModel | undefined {
  const wanted = togetherWireId(id).toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshTogetherCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<TogetherCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveTogetherApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('together', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < 300_000) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<TogetherCatalogueSnapshot | null> => {
    try {
      const result = await fetchTogetherLiveModels({ baseUrl: togetherApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: TogetherCatalogueSnapshot = { keySource: key.source, models: result.models, otherKinds: result.otherKinds, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof TogetherCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: TogetherCatalogueSnapshot = {
        keySource: key.source, models: refused ? [] : cached?.models ?? [], otherKinds: cached?.otherKinds ?? 0, fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
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

interface TogetherCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  free: boolean
  listedLive: boolean
}
type TogetherCatalogueSource = { kind: 'live'; count: number; otherKinds: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

function togetherPinRows(): TogetherCatalogueRow[] {
  return TOGETHER_DISPLAY_PINS.map(pin => ({ id: togetherQualifiedId(pin.id), displayName: pin.displayName, observedAt: TOGETHER_OBSERVED_AT, ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}), free: pin.free === true, listedLive: false }))
}

export function togetherCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: TogetherCatalogueRow[]; source: TogetherCatalogueSource } {
  const snapshot = getCachedTogetherCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: togetherPinRows(), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = togetherDisplayPin(model.id)
    const contextWindow = model.contextLength ?? pin?.contextWindow
    return { id: togetherQualifiedId(model.id), displayName: pin?.displayName ?? model.displayName ?? model.id, observedAt: pin ? TOGETHER_OBSERVED_AT : new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(contextWindow !== undefined ? { contextWindow } : {}), free: pin?.free === true || (model.pricing?.input === 0 && model.pricing?.output === 0), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, otherKinds: snapshot.otherKinds, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function togetherCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedTogetherCatalogue(env)
  const { source } = togetherCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list (observed ${TOGETHER_OBSERVED_AT}) — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no chat models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} chat ${source.count === 1 ? 'model' : 'models'} live${source.otherKinds > 0 ? ` · ${source.otherKinds} image, video, audio and other rows not listed` : ''}` : undefined
}

export function togetherContextWindowFor(model: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  return togetherListedModel(getCachedTogetherCatalogue(env), model)?.contextLength ?? togetherDisplayPin(model)?.contextWindow
}

export function __resetTogetherCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
