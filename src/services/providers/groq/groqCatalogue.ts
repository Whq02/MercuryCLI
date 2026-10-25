import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { groqApiBase, resolveGroqApiKey } from './groqAccounts.js'
import { GROQ_DISPLAY_PINS, GROQ_OBSERVED_AT, isGroqTextModelId, groqDisplayName, groqDisplayPin, groqWireId, groqQualifiedId } from './groqPins.js'

interface GroqLiveModel {
  id: string
  created: number
  ownedBy?: string
  contextWindow?: number
  outputMax?: number
}

function decodeGroqModel(raw: unknown): GroqLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isGroqTextModelId(row.id) || row.active === false) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  return { id: row.id.trim(), created, ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}),
    ...(typeof row.context_window === 'number' && Number.isFinite(row.context_window) && row.context_window > 0 ? { contextWindow: row.context_window } : {}),
    ...(typeof row.max_completion_tokens === 'number' && Number.isFinite(row.max_completion_tokens) && row.max_completion_tokens > 0 ? { outputMax: row.max_completion_tokens } : {}) }
}

export class GroqCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Groq models endpoint refused the credential (HTTP ${status})` : `Groq models endpoint returned HTTP ${status}`)
  }
}

export async function fetchGroqLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: GroqLiveModel[]; otherLines: number; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'groq', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new GroqCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('Groq models endpoint returned no data array')
  const seen = new Set<string>()
  const models: GroqLiveModel[] = []
  let otherLines = 0
  for (const raw of parsed.data) {
    const model = decodeGroqModel(raw)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = GROQ_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase())
    return index === -1 ? GROQ_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  return { models, otherLines, fetchedAtMs: Date.now() }
}

export interface GroqCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: GroqLiveModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, GroqCatalogueSnapshot>()
const inFlight = new Map<string, Promise<GroqCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveGroqApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${groqApiBase(env)}` : 'none'
}

export function getCachedGroqCatalogue(env: NodeJS.ProcessEnv = process.env): GroqCatalogueSnapshot | null {
  return resolveGroqApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

export function groqListedModel(snapshot: GroqCatalogueSnapshot | null, id: string): GroqLiveModel | undefined {
  const wanted = groqWireId(id).toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshGroqCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<GroqCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveGroqApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('groq', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < 300_000) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<GroqCatalogueSnapshot | null> => {
    try {
      const result = await fetchGroqLiveModels({ baseUrl: groqApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: GroqCatalogueSnapshot = { keySource: key.source, models: result.models, otherLines: result.otherLines, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof GroqCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: GroqCatalogueSnapshot = {
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

interface GroqCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
type GroqCatalogueSource = { kind: 'live'; count: number; otherLines: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

function groqPinRows(): GroqCatalogueRow[] {
  return GROQ_DISPLAY_PINS.map(pin => ({ id: groqQualifiedId(pin.id), displayName: pin.displayName, observedAt: GROQ_OBSERVED_AT, contextWindow: pin.contextWindow, listedLive: false }))
}

export function groqCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: GroqCatalogueRow[]; source: GroqCatalogueSource } {
  const snapshot = getCachedGroqCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: groqPinRows(), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = groqDisplayPin(model.id)
    return { id: groqQualifiedId(model.id), displayName: groqDisplayName(model.id), observedAt: (pin ? GROQ_OBSERVED_AT : undefined) ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...((model.contextWindow ?? pin?.contextWindow) !== undefined ? { contextWindow: model.contextWindow ?? pin?.contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function groqCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedGroqCatalogue(env)
  const { source } = groqCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list (observed ${GROQ_OBSERVED_AT}) — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no text models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} text ${source.count === 1 ? 'model' : 'models'} live${source.otherLines > 0 ? ` · ${source.otherLines} of other lines not listed` : ''}` : undefined
}

export function groqContextWindowFor(model: string): number | undefined {
  return groqListedModel(getCachedGroqCatalogue(), model)?.contextWindow ?? groqDisplayPin(model)?.contextWindow
}

export function groqOutputMaxFor(model: string): number | undefined {
  return groqListedModel(getCachedGroqCatalogue(), model)?.outputMax ?? groqDisplayPin(model)?.outputMax
}

export function __resetGroqCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
