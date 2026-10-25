import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { cerebrasApiBase, resolveCerebrasApiKey } from './cerebrasAccounts.js'
import { CEREBRAS_DISPLAY_PINS, CEREBRAS_OBSERVED_AT, isCerebrasTextModelId, cerebrasDisplayName, cerebrasDisplayPin, cerebrasWireId, cerebrasQualifiedId } from './cerebrasPins.js'

interface CerebrasLiveModel {
  id: string
  created: number
  ownedBy?: string
  contextWindow?: number
  outputMax?: number
}

function decodeCerebrasModel(raw: unknown): CerebrasLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isCerebrasTextModelId(row.id)) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  return { id: row.id.trim(), created, ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class CerebrasCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Cerebras models endpoint refused the credential (HTTP ${status})` : `Cerebras models endpoint returned HTTP ${status}`)
  }
}

export async function fetchCerebrasLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: CerebrasLiveModel[]; otherLines: number; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'cerebras', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new CerebrasCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('Cerebras models endpoint returned no data array')
  const seen = new Set<string>()
  const models: CerebrasLiveModel[] = []
  let otherLines = 0
  for (const raw of parsed.data) {
    const model = decodeCerebrasModel(raw)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = CEREBRAS_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase())
    return index === -1 ? CEREBRAS_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  return { models, otherLines, fetchedAtMs: Date.now() }
}

export interface CerebrasCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: CerebrasLiveModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, CerebrasCatalogueSnapshot>()
const inFlight = new Map<string, Promise<CerebrasCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveCerebrasApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${cerebrasApiBase(env)}` : 'none'
}

export function getCachedCerebrasCatalogue(env: NodeJS.ProcessEnv = process.env): CerebrasCatalogueSnapshot | null {
  return resolveCerebrasApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

export function cerebrasListedModel(snapshot: CerebrasCatalogueSnapshot | null, id: string): CerebrasLiveModel | undefined {
  const wanted = cerebrasWireId(id).toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshCerebrasCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<CerebrasCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveCerebrasApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('cerebras', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < 300_000) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<CerebrasCatalogueSnapshot | null> => {
    try {
      const result = await fetchCerebrasLiveModels({ baseUrl: cerebrasApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: CerebrasCatalogueSnapshot = { keySource: key.source, models: result.models, otherLines: result.otherLines, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof CerebrasCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: CerebrasCatalogueSnapshot = {
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

interface CerebrasCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
type CerebrasCatalogueSource = { kind: 'live'; count: number; otherLines: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

function cerebrasPinRows(): CerebrasCatalogueRow[] {
  return CEREBRAS_DISPLAY_PINS.map(pin => ({ id: cerebrasQualifiedId(pin.id), displayName: pin.displayName, observedAt: CEREBRAS_OBSERVED_AT, contextWindow: pin.contextWindow, listedLive: false }))
}

export function cerebrasCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: CerebrasCatalogueRow[]; source: CerebrasCatalogueSource } {
  const snapshot = getCachedCerebrasCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: cerebrasPinRows(), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.map(model => {
    const pin = cerebrasDisplayPin(model.id)
    return { id: cerebrasQualifiedId(model.id), displayName: cerebrasDisplayName(model.id), observedAt: (pin ? CEREBRAS_OBSERVED_AT : undefined) ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...((model.contextWindow ?? pin?.contextWindow) !== undefined ? { contextWindow: model.contextWindow ?? pin?.contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function cerebrasCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedCerebrasCatalogue(env)
  const { source } = cerebrasCatalogueRows(env)
  if (source.kind === 'pins') return `pinned list — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no text models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} text ${source.count === 1 ? 'model' : 'models'} live${source.otherLines > 0 ? ` · ${source.otherLines} of other lines not listed` : ''}` : undefined
}

export function cerebrasContextWindowFor(model: string): number | undefined {
  return cerebrasListedModel(getCachedCerebrasCatalogue(), model)?.contextWindow ?? cerebrasDisplayPin(model)?.contextWindow
}

export function cerebrasOutputMaxFor(model: string): number | undefined {
  return cerebrasListedModel(getCachedCerebrasCatalogue(), model)?.outputMax ?? cerebrasDisplayPin(model)?.outputMax
}

export function __resetCerebrasCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
