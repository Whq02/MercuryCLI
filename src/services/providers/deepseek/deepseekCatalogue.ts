import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { deepseekApiBase, resolveDeepseekApiKey } from './deepseekAccounts.js'
import {
  DEEPSEEK_DISPLAY_PINS,
  deepseekCurrentModelId,
  deepseekDisplayName,
  type DeepseekDisplayPin,
} from './deepseekPins.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const DEEPSEEK_CATALOGUE_TTL_MS = 5 * 60_000
const DEEPSEEK_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface DeepseekLiveModel {
  id: string
  ownedBy?: string
  displayName?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function decodeDeepseekModel(raw: unknown): DeepseekLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return undefined
  const ownedBy = str(r.owned_by)
  const displayName = str(r.display_name)
  return {
    id: id.trim(),
    ...(ownedBy !== undefined ? { ownedBy } : {}),
    ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
  }
}

export async function fetchDeepseekLiveModels(opts: {
  baseUrl: string
  key: string
  fetchImpl?: typeof fetch
}): Promise<{ models: DeepseekLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'deepseek', CATALOGUE_FETCH_TIMEOUT_MS, `${opts.baseUrl}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${opts.key}`,
        'user-agent': getUserAgent(),
      },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? `deepseek models endpoint refused the credential (HTTP ${response.status})`
        : `deepseek models endpoint returned HTTP ${response.status}`,
    )
  }
  const parsed = (await catalogueBodyJson(response)) as Record<string, unknown>
  const data = Array.isArray(parsed.data) ? parsed.data : []
  const models: DeepseekLiveModel[] = []
  for (const raw of data) {
    const model = decodeDeepseekModel(raw)
    if (model) models.push(model)
  }
  return { models, fetchedAtMs: Date.now() }
}

export interface DeepseekCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: DeepseekLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, DeepseekCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<DeepseekCatalogueSnapshot | null>>()

function catalogueIdentity(env: NodeJS.ProcessEnv): string {
  const key = resolveDeepseekApiKey(env)
  if (!key) return 'none'
  return `${key.source}:${credentialFingerprint(key.key)}:${deepseekApiBase(env)}`
}

export function getCachedDeepseekCatalogue(env: NodeJS.ProcessEnv = process.env): DeepseekCatalogueSnapshot | null {
  if (!resolveDeepseekApiKey(env)) return null
  return catalogueCache.get(catalogueIdentity(env)) ?? null
}

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>()
const liveIdSets = new WeakMap<DeepseekCatalogueSnapshot, ReadonlySet<string>>()

export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (catalogueCache.size === 0) return EMPTY_LIVE_IDS
  const snapshot = getCachedDeepseekCatalogue(env)
  if (!snapshot || snapshot.fetchedAtMs === 0 || snapshot.models.length === 0) return EMPTY_LIVE_IDS
  let ids = liveIdSets.get(snapshot)
  if (ids === undefined) {
    ids = new Set(snapshot.models.map(m => deepseekCurrentModelId(m.id.trim().toLowerCase())))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

function nothingUsable(snapshot: DeepseekCatalogueSnapshot | null): boolean {
  return snapshot === null || (snapshot.models.length === 0 && snapshot.lastError !== undefined)
}

export function refreshDeepseekCatalogue(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<DeepseekCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = resolveDeepseekApiKey(env)
  const identity = catalogueIdentity(env)
  const cached = key ? (catalogueCache.get(identity) ?? null) : null
  if (!key || !catalogueTrafficVerdict('deepseek', env).allowed) {
    return Promise.resolve(cached)
  }
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window = cached && nothingUsable(cached) ? DEEPSEEK_CATALOGUE_FAILURE_RETRY_MS : DEEPSEEK_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<DeepseekCatalogueSnapshot | null> => {
    try {
      const result = await fetchDeepseekLiveModels({
        baseUrl: deepseekApiBase(env),
        key: key.key,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: DeepseekCatalogueSnapshot = { keySource: key.source, models: result.models, fetchedAtMs: now() }
      catalogueCache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: DeepseekCatalogueSnapshot = {
        keySource: key.source,
        models: cached?.models ?? [],
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: error instanceof Error ? error.message : String(error),
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

export function kickDeepseekCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('deepseek', env).allowed) return false
  if (!nothingUsable(getCachedDeepseekCatalogue(env))) return false
  void refreshDeepseekCatalogue({ env, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }).catch(() => null)
  return true
}

export interface DeepseekCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}

export type DeepseekCatalogueSource =
  | { kind: 'live'; count: number; fetchedAtMs: number }
  | { kind: 'pin'; observedAt: string }

function pinRow(pin: DeepseekDisplayPin, listedLive: boolean): DeepseekCatalogueRow {
  return {
    id: pin.id,
    displayName: pin.displayName,
    observedAt: pin.observedAt,
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    listedLive,
  }
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function deepseekCatalogueRows(env: NodeJS.ProcessEnv = process.env): {
  rows: DeepseekCatalogueRow[]
  source: DeepseekCatalogueSource
} {
  const snapshot = getCachedDeepseekCatalogue(env)
  if (!snapshot || snapshot.models.length === 0) {
    return {
      rows: DEEPSEEK_DISPLAY_PINS.map(pin => pinRow(pin, false)),
      source: { kind: 'pin', observedAt: DEEPSEEK_DISPLAY_PINS[0]?.observedAt ?? '' },
    }
  }
  const listed = new Set(snapshot.models.map(m => deepseekCurrentModelId(m.id.trim().toLowerCase())))
  const rows: DeepseekCatalogueRow[] = DEEPSEEK_DISPLAY_PINS.filter(pin => listed.has(pin.id)).map(pin => pinRow(pin, true))
  const taken = new Set(rows.map(row => row.id))
  for (const model of snapshot.models) {
    const id = deepseekCurrentModelId(model.id.trim().toLowerCase())
    if (taken.has(id)) continue
    taken.add(id)
    rows.push({ id, displayName: model.displayName ?? deepseekDisplayName(id), observedAt: dateOf(snapshot.fetchedAtMs), listedLive: true })
  }
  return { rows, source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function deepseekCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { source } = deepseekCatalogueRows(env)
  if (source.kind !== 'live') return undefined
  return `${source.count} ${source.count === 1 ? 'model' : 'models'} live`
}

export function __resetDeepseekCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
