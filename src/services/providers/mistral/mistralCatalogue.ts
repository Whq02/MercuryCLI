import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { mistralApiBase, resolveMistralApiKey } from './mistralAccounts.js'
import { MISTRAL_DISPLAY_PINS, isMistralChatModelId, mistralDisplayName, mistralDisplayPin } from './mistralPins.js'

export interface MistralLiveModel {
  id: string
  created: number
  aliases: string[]
  contextWindow?: number
  reasoning?: boolean
  vision?: boolean
  tools?: boolean
  deprecation?: string
}

export function decodeMistralModel(raw: unknown): MistralLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isMistralChatModelId(row.id)) return undefined
  const capabilities = typeof row.capabilities === 'object' && row.capabilities !== null ? row.capabilities as Record<string, unknown> : {}
  if (capabilities.completion_chat === false) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  const aliases = Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '').map(alias => alias.trim()) : []
  const context = row.max_context_length
  return {
    id: row.id.trim(), created, aliases,
    ...(typeof context === 'number' && Number.isFinite(context) && context > 0 ? { contextWindow: Math.floor(context) } : {}),
    ...(typeof capabilities.reasoning === 'boolean' ? { reasoning: capabilities.reasoning } : {}),
    ...(typeof capabilities.vision === 'boolean' ? { vision: capabilities.vision } : {}),
    ...(typeof capabilities.function_calling === 'boolean' ? { tools: capabilities.function_calling } : {}),
    ...(typeof row.deprecation === 'string' && row.deprecation.trim() !== '' ? { deprecation: row.deprecation.trim() } : {}),
  }
}

export class MistralCatalogueHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? `Mistral models endpoint refused the credential (HTTP ${status})` : `Mistral models endpoint returned HTTP ${status}`)
  }
}

export async function fetchMistralLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<{ models: MistralLiveModel[]; fetchedAtMs: number }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'mistral', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new MistralCatalogueHttpError(response.status)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error('Mistral models endpoint returned no data array')
  const seen = new Set<string>()
  const models: MistralLiveModel[] = []
  for (const raw of parsed.data) {
    const model = decodeMistralModel(raw)
    if (!model || seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  const pinRank = (id: string): number => {
    const index = MISTRAL_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase() || pin.aliases.includes(id.toLowerCase()))
    return index === -1 ? MISTRAL_DISPLAY_PINS.length : index
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  return { models, fetchedAtMs: Date.now() }
}

export interface MistralCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: MistralLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, MistralCatalogueSnapshot>()
const inFlight = new Map<string, Promise<MistralCatalogueSnapshot | null>>()
function identityOf(env: NodeJS.ProcessEnv): string {
  const key = resolveMistralApiKey(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${mistralApiBase(env)}` : 'none'
}

export function getCachedMistralCatalogue(env: NodeJS.ProcessEnv = process.env): MistralCatalogueSnapshot | null {
  return resolveMistralApiKey(env) ? cache.get(identityOf(env)) ?? null : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<MistralCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedMistralCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.flatMap(row => [row.id.toLowerCase(), ...row.aliases.map(alias => alias.toLowerCase())]))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function mistralListedModel(snapshot: MistralCatalogueSnapshot | null, id: string): MistralLiveModel | undefined {
  const wanted = id.trim().toLowerCase()
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted || row.aliases.some(alias => alias.toLowerCase() === wanted))
}

export function refreshMistralCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<MistralCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveMistralApiKey(env)
  const identity = identityOf(env)
  const cached = key ? cache.get(identity) ?? null : null
  if (!key || !catalogueTrafficVerdict('mistral', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < (cached.lastError ? 10_000 : 300_000)) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const work = (async (): Promise<MistralCatalogueSnapshot | null> => {
    try {
      const result = await fetchMistralLiveModels({ baseUrl: mistralApiBase(env), key: key.key, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: MistralCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof MistralCatalogueHttpError && (error.status === 401 || error.status === 403)
      const snapshot: MistralCatalogueSnapshot = {
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

export function kickMistralCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('mistral', env).allowed) return false
  const snapshot = getCachedMistralCatalogue(env)
  if (snapshot && !snapshot.lastError) return false
  void refreshMistralCatalogue(opts).catch(() => null)
  return true
}

export interface MistralCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
export type MistralCatalogueSource = { kind: 'live'; count: number; fetchedAtMs: number } | { kind: 'unread' }

export function mistralCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: MistralCatalogueRow[]; source: MistralCatalogueSource } {
  const snapshot = getCachedMistralCatalogue(env)
  if (!snapshot?.fetchedAtMs) return { rows: [], source: { kind: 'unread' } }
  const rows = snapshot.models.filter(model => model.deprecation === undefined).map(model => {
    const pin = mistralDisplayPin(model.id)
    const contextWindow = model.contextWindow ?? pin?.contextWindow
    return { id: model.id, displayName: mistralDisplayName(model.id), observedAt: pin?.observedAt ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(contextWindow !== undefined ? { contextWindow } : {}), listedLive: true }
  })
  return { rows, source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function newestMistralModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return mistralCatalogueRows(env).rows[0]?.id
}

export function mistralCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedMistralCatalogue(env)
  if (snapshot?.lastError) return snapshot.lastError
  const { source } = mistralCatalogueRows(env)
  return source.kind === 'live' ? `${source.count} ${source.count === 1 ? 'model' : 'models'} live` : undefined
}

export function mistralModelFacts(id: string, env: NodeJS.ProcessEnv = process.env): { contextWindow?: number; reasoning?: boolean; images?: boolean; tools?: boolean; efforts: readonly string[] } {
  const pin = mistralDisplayPin(id)
  const live = mistralListedModel(getCachedMistralCatalogue(env), id)
  const reasoning = live?.reasoning ?? pin?.reasoning
  const contextWindow = live?.contextWindow ?? pin?.contextWindow
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...((live?.vision ?? pin?.images) !== undefined ? { images: live?.vision ?? pin?.images } : {}),
    ...((live?.tools ?? pin?.tools) !== undefined ? { tools: live?.tools ?? pin?.tools } : {}),
    efforts: reasoning === true ? pin?.efforts ?? ['none', 'high'] : [],
  }
}

export function __resetMistralCatalogueForTest(): void {
  cache.clear()
  inFlight.clear()
}
