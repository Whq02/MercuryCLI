import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable, quietBodyJson, serviceWordsOf, wordsNameTheKey, type ServiceWords } from '../catalogueBody.js'
import { resolveZaiDispatch, type ZaiDispatch } from './zaiAccounts.js'
import { zaiApiBase, type ZaiApiPlan } from './zaiClient.js'
import { rememberZaiKeyPlan, type ZaiKeyPlanWord } from './zaiKeyPlan.js'
import { GLM_STATIC_FLOOR_IDS, glmDisplayName, glmDisplayPin } from './glmPins.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const ZAI_CATALOGUE_TTL_MS = 5 * 60_000

interface ZaiLiveModel {
  id: string
  ownedBy?: string
  created?: number
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function decodeZaiModel(raw: unknown): ZaiLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return undefined
  const ownedBy = str(r.owned_by)
  const created = typeof r.created === 'number' && Number.isSafeInteger(r.created) && r.created > 0 ? r.created : undefined
  return {
    id,
    ...(ownedBy !== undefined ? { ownedBy } : {}),
    ...(created !== undefined ? { created } : {}),
  }
}

class ZaiCatalogueHttpError extends Error {
  readonly refused: boolean
  readonly said: string | undefined
  constructor(readonly status: number, words: ServiceWords = {}, key = '', where = '') {
    const refused = status === 401 || status === 403 || (status === 400 && wordsNameTheKey(words))
    const said = (words.message ?? words.code)?.split(key || '\0').join('[redacted]')
    super(`${refused ? `Z.AI models endpoint refused the credential (HTTP ${status})` : `Z.AI models endpoint returned HTTP ${status}`}${where}${said ? ` — ${said}` : ''}`)
    this.refused = refused
    this.said = said
  }
}

export type ZaiKeyProbe =
  | { state: 'accepted'; models: number }
  | { state: 'refused'; status: number; message?: string }
  | { state: 'unreachable'; message: string }

export async function probeZaiKey(key: string, plan: ZaiApiPlan, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<ZaiKeyProbe> {
  try {
    const result = await fetchZaiLiveModels({ baseUrl: zaiApiBase(io?.env ?? process.env, plan), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    return { state: 'accepted', models: result.models.length }
  } catch (error) {
    if (error instanceof ZaiCatalogueHttpError && error.refused) return { state: 'refused', status: error.status, ...(error.said ? { message: error.said } : {}) }
    return { state: 'unreachable', message: (error instanceof Error ? error.message : String(error)).split(key).join('[redacted]') }
  }
}

async function fetchZaiLiveModels(opts: {
  baseUrl: string
  key: string
  fetchImpl?: typeof fetch
}): Promise<{ models: ZaiLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'zai', CATALOGUE_FETCH_TIMEOUT_MS, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new ZaiCatalogueHttpError(response.status, serviceWordsOf(await quietBodyJson(response)), opts.key)
  const parsed = (await catalogueBodyJson(response)) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.data)) throw new Error('Z.AI models endpoint returned no data array')
  const models: ZaiLiveModel[] = []
  const taken = new Set<string>()
  for (const raw of parsed.data) {
    const model = decodeZaiModel(raw)
    if (!model || taken.has(model.id.toLowerCase())) continue
    taken.add(model.id.toLowerCase())
    models.push(model)
  }
  if (parsed.data.length > 0 && models.length === 0) throw new Error('the models endpoint answered a non-catalogue view (no listed row carries a model id)')
  return { models, fetchedAtMs: Date.now() }
}

type ZaiPlanLearning =
  | { plan: ZaiKeyPlanWord; models: ZaiLiveModel[]; fetchedAtMs: number }
  | { plan: undefined; refused: boolean; error: Error }

export async function learnZaiKeyPlan(key: string, io?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<ZaiPlanLearning> {
  const env = io?.env ?? process.env
  const fetchImpl = io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}
  const asked = new Set<string>()
  let refusal: ZaiCatalogueHttpError | undefined
  for (const plan of ['general', 'coding'] as const) {
    const baseUrl = zaiApiBase(env, plan)
    if (asked.has(baseUrl)) continue
    asked.add(baseUrl)
    try {
      const result = await fetchZaiLiveModels({ baseUrl, key, ...fetchImpl })
      rememberZaiKeyPlan(key, plan)
      return { plan, models: result.models, fetchedAtMs: result.fetchedAtMs }
    } catch (error) {
      if (error instanceof ZaiCatalogueHttpError && error.refused) {
        refusal ??= error
        continue
      }
      return { plan: undefined, refused: false, error: error instanceof Error ? error : new Error(String(error).split(key).join('[redacted]')) }
    }
  }
  const first = refusal ?? new ZaiCatalogueHttpError(401)
  return {
    plan: undefined,
    refused: true,
    error: asked.size > 1 ? new ZaiCatalogueHttpError(first.status, first.said !== undefined ? { message: first.said } : {}, '', ' on the general base and on the Coding Plan base') : first,
  }
}

async function listForDispatch(dispatch: ZaiDispatch, env: NodeJS.ProcessEnv, fetchImpl: { fetchImpl?: typeof fetch }): Promise<{ plan: ZaiKeyPlanWord; models: ZaiLiveModel[]; fetchedAtMs: number }> {
  if (dispatch.planSource !== 'assumed') {
    const result = await fetchZaiLiveModels({ baseUrl: listBase(env, dispatch.plan), key: dispatch.key, ...fetchImpl })
    return { plan: dispatch.plan, models: result.models, fetchedAtMs: result.fetchedAtMs }
  }
  const learned = await learnZaiKeyPlan(dispatch.key, { env, ...fetchImpl })
  if (learned.plan === undefined) throw learned.error
  return learned
}

export interface ZaiCatalogueSnapshot {
  keySource: 'env' | 'stored'
  plan: 'general' | 'coding'
  models: ZaiLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, ZaiCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<ZaiCatalogueSnapshot | null>>()

function listBase(env: NodeJS.ProcessEnv, plan: 'general' | 'coding'): string {
  const { zaiApiBase } = require('./zaiClient.js') as typeof import('./zaiClient.js')
  return zaiApiBase(env, plan)
}

function catalogueIdentity(env: NodeJS.ProcessEnv): string {
  const dispatch = resolveZaiDispatch(env)
  if (!dispatch) return 'none'
  return `${dispatch.source}:${credentialFingerprint(dispatch.key)}:${listBase(env, dispatch.plan)}`
}

export function getCachedZaiCatalogue(env: NodeJS.ProcessEnv = process.env): ZaiCatalogueSnapshot | null {
  if (!resolveZaiDispatch(env)) return null
  return catalogueCache.get(catalogueIdentity(env)) ?? null
}

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>()
const liveIdSets = new WeakMap<ZaiCatalogueSnapshot, ReadonlySet<string>>()

export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (catalogueCache.size === 0) return EMPTY_LIVE_IDS
  const snapshot = getCachedZaiCatalogue(env)
  if (!snapshot || snapshot.fetchedAtMs === 0 || snapshot.models.length === 0) return EMPTY_LIVE_IDS
  let ids = liveIdSets.get(snapshot)
  if (ids === undefined) {
    ids = new Set(snapshot.models.map(m => m.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

function nothingUsable(snapshot: ZaiCatalogueSnapshot | null): boolean {
  return snapshot === null || (snapshot.models.length === 0 && snapshot.lastError !== undefined)
}

export function refreshZaiCatalogue(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<ZaiCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const dispatch = resolveZaiDispatch(env)
  const identity = catalogueIdentity(env)
  const cached = dispatch ? (catalogueCache.get(identity) ?? null) : null
  if (!dispatch || !catalogueTrafficVerdict('zai', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < ZAI_CATALOGUE_TTL_MS) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<ZaiCatalogueSnapshot | null> => {
    try {
      const result = await listForDispatch(dispatch, env, opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
      const snapshot: ZaiCatalogueSnapshot = { keySource: dispatch.source, plan: result.plan, models: result.models, fetchedAtMs: now() }
      catalogueCache.set(catalogueIdentity(env), snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof ZaiCatalogueHttpError && error.refused
      const snapshot: ZaiCatalogueSnapshot = {
        keySource: dispatch.source,
        plan: dispatch.plan,
        models: refused ? [] : (cached?.models ?? []),
        fetchedAtMs: refused ? 0 : (cached?.fetchedAtMs ?? 0),
        lastAttemptAtMs: now(),
        lastError: (error instanceof Error ? error.message : String(error)).split(dispatch.key).join('[redacted]'),
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

export function kickZaiCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('zai', env).allowed) return false
  if (!nothingUsable(getCachedZaiCatalogue(env))) return false
  void refreshZaiCatalogue({ env, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }).catch(() => null)
  return true
}

interface ZaiCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
  liveUnknown?: boolean
}

type ZaiCatalogueSource =
  | { kind: 'live'; count: number; fetchedAtMs: number }
  | { kind: 'pin'; observedAt: string }

function floorRows(): ZaiCatalogueRow[] {
  const rows: ZaiCatalogueRow[] = []
  for (const id of GLM_STATIC_FLOOR_IDS) {
    const pin = glmDisplayPin(id)
    if (!pin) continue
    rows.push({ id: pin.id, displayName: pin.displayName, observedAt: pin.observedAt, ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}), listedLive: false })
  }
  return rows
}

export function zaiCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: ZaiCatalogueRow[]; source: ZaiCatalogueSource } {
  const snapshot = getCachedZaiCatalogue(env)
  if (!snapshot || snapshot.models.length === 0) {
    const rows = floorRows()
    return { rows, source: { kind: 'pin', observedAt: rows[0]?.observedAt ?? '' } }
  }
  const fetchedOn = new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10)
  const rows: ZaiCatalogueRow[] = []
  const taken = new Set<string>()
  for (const model of snapshot.models.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0))) {
    const id = model.id.toLowerCase()
    if (taken.has(id)) continue
    taken.add(id)
    const pin = glmDisplayPin(id)
    rows.push({
      id,
      displayName: pin?.displayName ?? glmDisplayName(id),
      observedAt: pin?.observedAt ?? fetchedOn,
      ...(pin?.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
      listedLive: true,
      ...(pin ? {} : { liveUnknown: true }),
    })
  }
  return { rows, source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function zaiCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { source } = zaiCatalogueRows(env)
  if (source.kind !== 'live') return undefined
  return `${source.count} ${source.count === 1 ? 'model' : 'models'} live`
}

export function __resetZaiCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
