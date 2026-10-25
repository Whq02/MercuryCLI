import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { minimaxApiBase, resolveMinimaxApiKey } from './minimaxAccounts.js'
import { MINIMAX_DISPLAY_PINS, isMinimaxTextModelId, minimaxDisplayName, minimaxDisplayPin, type MinimaxThinkingDial } from './minimaxPins.js'

export interface MinimaxLiveModel {
  id: string
  created: number
  ownedBy?: string
}

export function decodeMinimaxModel(raw: unknown): MinimaxLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isMinimaxTextModelId(row.id)) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  return { id: row.id.trim(), created, ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class MinimaxCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `MiniMax models endpoint refused the credential (HTTP ${status})` : `MiniMax models endpoint returned HTTP ${status}`)
  }
}

export function minimaxBaseRespFailure(body: unknown): { code: number; message: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const base = (body as Record<string, unknown>).base_resp
  if (typeof base !== 'object' || base === null) return undefined
  const code = (base as Record<string, unknown>).status_code
  if (typeof code !== 'number' || !Number.isFinite(code) || code === 0) return undefined
  const message = (base as Record<string, unknown>).status_msg
  return { code, message: typeof message === 'string' && message !== '' ? message : `MiniMax status ${code}` }
}

const MINIMAX_AUTH_CODES: ReadonlySet<number> = new Set([1004, 2049])
const MINIMAX_OTHER_GROUP = /not match group/i

export function minimaxPlanAnswerVerdict(vendor: { code: number; message: string } | undefined): 'refused' | 'other-group' | undefined {
  if (!vendor || !MINIMAX_AUTH_CODES.has(vendor.code)) return undefined
  return vendor.code === 1004 && MINIMAX_OTHER_GROUP.test(vendor.message) ? 'other-group' : 'refused'
}

export async function fetchMinimaxLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: MinimaxLiveModel[]; otherLines: number; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'minimax', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new MinimaxCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  const refused = minimaxBaseRespFailure(parsed)
  if (refused) throw new MinimaxCatalogueHttpError(MINIMAX_AUTH_CODES.has(refused.code) ? 401 : 502)
  if (!Array.isArray(parsed?.data)) throw new Error('MiniMax models endpoint returned no data array')
  const seen = new Set<string>()
  const models: MinimaxLiveModel[] = []
  let otherLines = 0
  for (const raw of parsed.data) {
    const model = decodeMinimaxModel(raw)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = MINIMAX_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase())
    return index === -1 ? MINIMAX_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  return { models, otherLines, fetchedAtMs: Date.now() }
}

export interface MinimaxCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: MinimaxLiveModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, MinimaxCatalogueSnapshot>()
const inFlight = new Map<string, Promise<MinimaxCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveMinimaxApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${minimaxApiBase(env)}` : 'none'
}

export function getCachedMinimaxCatalogue(env: NodeJS.ProcessEnv = process.env): MinimaxCatalogueSnapshot | null {
  return resolveMinimaxApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<MinimaxCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedMinimaxCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.map(row => row.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function minimaxListedModel(snapshot: MinimaxCatalogueSnapshot | null, id: string): MinimaxLiveModel | undefined {
  const wanted = id.trim().toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshMinimaxCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<MinimaxCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveMinimaxApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('minimax', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < 300_000) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<MinimaxCatalogueSnapshot | null> => {
    try {
      const result = await fetchMinimaxLiveModels({ baseUrl: minimaxApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: MinimaxCatalogueSnapshot = { keySource: key.source, models: result.models, otherLines: result.otherLines, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof MinimaxCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: MinimaxCatalogueSnapshot = {
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

export function kickMinimaxCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('minimax', env).allowed) return false
  const snapshot = getCachedMinimaxCatalogue(env)
  if (snapshot && !snapshot.lastError) return false
  void refreshMinimaxCatalogue(opts).catch(() => null)
  return true
}

export interface MinimaxCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
export type MinimaxCatalogueSource = { kind: 'live'; count: number; otherLines: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

export function minimaxPinRows(): MinimaxCatalogueRow[] {
  return MINIMAX_DISPLAY_PINS.map(pin => ({ id: pin.wireId, displayName: pin.displayName, observedAt: pin.observedAt, contextWindow: pin.contextWindow, listedLive: false }))
}

export function minimaxCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: MinimaxCatalogueRow[]; source: MinimaxCatalogueSource } {
  const snapshot = getCachedMinimaxCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: minimaxPinRows(), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = minimaxDisplayPin(model.id)
    return { id: model.id, displayName: minimaxDisplayName(model.id), observedAt: pin?.observedAt ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(pin ? { contextWindow: pin.contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function newestMinimaxModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return minimaxCatalogueRows(env).rows[0]?.id
}

export function minimaxWireId(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const asked = model.trim().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  return minimaxListedModel(getCachedMinimaxCatalogue(env), asked)?.id ?? minimaxDisplayPin(asked)?.wireId ?? asked
}

export function minimaxCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedMinimaxCatalogue(env)
  const { source } = minimaxCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no text models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} text ${source.count === 1 ? 'model' : 'models'} live${source.otherLines > 0 ? ` · ${source.otherLines} of other lines not listed` : ''}` : undefined
}

export function minimaxModelFacts(id: string): { contextWindow?: number; outputMax?: number; thinking: MinimaxThinkingDial | undefined; images?: boolean; tools?: boolean; efforts: readonly string[] } {
  const pin = minimaxDisplayPin(id)
  return {
    ...(pin ? { contextWindow: pin.contextWindow, outputMax: pin.outputMax, images: pin.images, tools: pin.tools } : {}),
    thinking: pin?.thinking,
    efforts: pin?.efforts ?? [],
  }
}

export function __resetMinimaxCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
