import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'
import { modelNotOfferedByCatalogue } from '../catalogueAdmission.js'
import {
  kimiCodingBase,
  moonshotAliasesServing,
  moonshotApiBase,
  moonshotServedModels,
  moonshotStoredTokens,
  resolveMoonshotAccount,
  resolveMoonshotApiKey,
  resolveMoonshotDispatchCredential,
  type MoonshotDispatchSource,
} from './moonshotAccounts.js'
import { signInLedgerEpoch } from '../../../utils/accounts/signInLedger.js'
import { KIMI_DISPLAY_PINS, kimiDisplayPin, kimiMechanicalName, kimiShortName } from './kimiPins.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const MOONSHOT_CATALOGUE_TTL_MS = 5 * 60_000
const MOONSHOT_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface MoonshotLiveModel {
  id: string
  ownedBy?: string
  created?: number
  displayName?: string
  contextWindow?: number
  supportsImage?: boolean
  supportsVideo?: boolean
  supportsReasoning?: boolean
}

export function decodeMoonshotModel(raw: unknown): MoonshotLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.trim() === '') return undefined
  return {
    id: r.id.trim(),
    ...(typeof r.owned_by === 'string' && r.owned_by.trim() ? { ownedBy: r.owned_by } : {}),
    ...(typeof r.created === 'number' && Number.isSafeInteger(r.created) && r.created >= 0 ? { created: r.created } : {}),
    ...(typeof r.display_name === 'string' && r.display_name.trim() ? { displayName: r.display_name } : {}),
    ...(typeof r.context_length === 'number' && Number.isSafeInteger(r.context_length) && r.context_length > 0 ? { contextWindow: r.context_length } : {}),
    ...(typeof r.supports_image_in === 'boolean' ? { supportsImage: r.supports_image_in } : {}),
    ...(typeof r.supports_video_in === 'boolean' ? { supportsVideo: r.supports_video_in } : {}),
    ...(typeof r.supports_reasoning === 'boolean' ? { supportsReasoning: r.supports_reasoning } : {}),
  }
}

export async function fetchMoonshotLiveModels(opts: {
  baseUrl: string
  key: string
  fetchImpl?: typeof fetch
}): Promise<{ models: MoonshotLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'moonshot', CATALOGUE_FETCH_TIMEOUT_MS, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? `Moonshot models endpoint refused the credential (HTTP ${response.status})`
      : `Moonshot models endpoint returned HTTP ${response.status}`)
  }
  const parsed = await catalogueBodyJson(response)
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).data)) {
    throw new Error('Moonshot models endpoint returned a malformed catalogue')
  }
  const data = (parsed as { data: unknown[] }).data
  const models = data.map(decodeMoonshotModel).filter((model): model is MoonshotLiveModel => model !== undefined)
  if (data.length > 0 && models.length === 0) {
    throw new Error('the models endpoint answered a non-catalogue view (no listed row carries a model id)')
  }
  return { models, fetchedAtMs: Date.now() }
}

export interface MoonshotCatalogueSnapshot {
  source: MoonshotDispatchSource
  models: MoonshotLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, MoonshotCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<MoonshotCatalogueSnapshot | null>>()

function catalogueIdentity(env: NodeJS.ProcessEnv): string {
  const account = resolveMoonshotAccount(env)
  if (!account) return 'none'
  if (account.kind === 'kimi-oauth') {
    return `kimi-oauth:${credentialFingerprint(moonshotStoredTokens()?.accessToken ?? '')}:${kimiCodingBase(account.region, env)}`
  }
  return `${account.keySource}:${credentialFingerprint(resolveMoonshotApiKey(env)?.key ?? '')}:${moonshotApiBase(env)}`
}

export function getCachedMoonshotCatalogue(env: NodeJS.ProcessEnv = process.env): MoonshotCatalogueSnapshot | null {
  if (!resolveMoonshotAccount(env)) return null
  return catalogueCache.get(catalogueIdentity(env)) ?? null
}

const NO_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<MoonshotCatalogueSnapshot, ReadonlySet<string>>()
let identityMemo: { epoch: number; spellings: string; identity: string } | null = null

function memoisedIdentity(env: NodeJS.ProcessEnv): string {
  const epoch = signInLedgerEpoch()
  const spellings = `${env.MOONSHOT_API_KEY ?? ''}\u0000${env.MERCURY_MOONSHOT_API_BASE ?? ''}\u0000${env.MERCURY_MOONSHOT_CODING_BASE ?? ''}`
  if (env === process.env && identityMemo !== null && identityMemo.epoch === epoch && identityMemo.spellings === spellings) return identityMemo.identity
  const identity = catalogueIdentity(env)
  if (env === process.env) identityMemo = { epoch, spellings, identity }
  return identity
}

export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const identity = memoisedIdentity(env)
  if (identity === 'none') return NO_IDS
  const snapshot = catalogueCache.get(identity)
  if (snapshot === undefined || snapshot.fetchedAtMs === 0) return NO_IDS
  const known = liveIdSets.get(snapshot)
  if (known !== undefined) return known
  const ids: ReadonlySet<string> = new Set(snapshot.models.map(model => model.id.trim().toLowerCase()))
  liveIdSets.set(snapshot, ids)
  return ids
}

export function refreshMoonshotCatalogue(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<MoonshotCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const account = resolveMoonshotAccount(env)
  const identity = catalogueIdentity(env)
  const cached = account ? catalogueCache.get(identity) ?? null : null
  if (!account || !catalogueTrafficVerdict('moonshot', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window = cached?.lastError && cached.fetchedAtMs === 0 ? MOONSHOT_CATALOGUE_FAILURE_RETRY_MS : MOONSHOT_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<MoonshotCatalogueSnapshot | null> => {
    let destination = identity
    let source: MoonshotDispatchSource = account.kind === 'kimi-oauth' ? 'kimi-oauth' : account.keySource
    try {
      const credential = await resolveMoonshotDispatchCredential({ env, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      if (!credential) throw new Error('Moonshot account could not produce a model-list credential')
      const baseUrl = credential.requestUrl.replace(/\/chat\/completions$/, '')
      source = credential.source
      destination = `${source}:${credentialFingerprint(credential.apiKey)}:${baseUrl}`
      const result = await fetchMoonshotLiveModels({ baseUrl, key: credential.apiKey, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      const snapshot: MoonshotCatalogueSnapshot = { source, models: result.models, fetchedAtMs: now() }
      catalogueCache.set(destination, snapshot)
      return snapshot
    } catch (error) {
      const previous = catalogueCache.get(destination)
      const snapshot: MoonshotCatalogueSnapshot = {
        source,
        models: previous?.models ?? [],
        fetchedAtMs: previous?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
      catalogueCache.set(destination, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      bumpCatalogueEpoch()
    }
  })()
  catalogueInFlight.set(identity, work)
  return work
}

export function kickMoonshotCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('moonshot', env).allowed) return false
  const snapshot = getCachedMoonshotCatalogue(env)
  if (snapshot && snapshot.fetchedAtMs > 0) return false
  void refreshMoonshotCatalogue(opts).catch(() => null)
  return true
}

export interface MoonshotCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
  servedAs?: { id: string; displayName: string }
}

export type MoonshotCatalogueSource =
  | { kind: 'live'; count: number; fetchedAtMs: number }
  | { kind: 'pin'; observedAt: string }
  | { kind: 'unread'; reading: boolean; error?: string }

function unreadSource(snapshot: MoonshotCatalogueSnapshot | null, env: NodeJS.ProcessEnv): MoonshotCatalogueSource {
  const verdict = catalogueTrafficVerdict('moonshot', env)
  if (!verdict.allowed) return { kind: 'unread', reading: false, error: verdict.reason }
  const error = snapshot?.lastError
  return { kind: 'unread', reading: catalogueInFlight.has(catalogueIdentity(env)) || error === undefined, ...(error !== undefined ? { error } : {}) }
}

function baseAliasLeads(rows: MoonshotCatalogueRow[]): MoonshotCatalogueRow[] {
  const ids = rows.map(row => row.id)
  const baseOf = (id: string): string | undefined => {
    let base: string | undefined
    for (const other of ids) {
      if (other !== id && id.startsWith(`${other}-`) && (base === undefined || other.length > base.length)) base = other
    }
    return base
  }
  const heads: MoonshotCatalogueRow[] = []
  const variants = new Map<string, MoonshotCatalogueRow[]>()
  for (const row of rows) {
    const base = baseOf(row.id)
    if (base === undefined) heads.push(row)
    else variants.set(base, [...(variants.get(base) ?? []), row])
  }
  const ordered: MoonshotCatalogueRow[] = []
  const place = (row: MoonshotCatalogueRow): void => {
    ordered.push(row)
    for (const variant of variants.get(row.id) ?? []) place(variant)
  }
  for (const head of heads) place(head)
  return ordered
}

const PLAN_HEADS = ['k3', 'k3-256k'] as const

function planHeadLeads(rows: MoonshotCatalogueRow[]): MoonshotCatalogueRow[] {
  const head = PLAN_HEADS.map(id => rows.find(row => row.id === id)).find(row => row !== undefined)
  if (head === undefined) return rows
  return [head, ...rows.filter(row => row !== head)]
}

export function moonshotCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: MoonshotCatalogueRow[]; source: MoonshotCatalogueSource } {
  if (resolveMoonshotAccount(env) === undefined) {
    return {
      rows: KIMI_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName, observedAt: pin.observedAt, ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}), listedLive: false })),
      source: { kind: 'pin', observedAt: KIMI_DISPLAY_PINS[0]?.observedAt ?? '' },
    }
  }
  const snapshot = getCachedMoonshotCatalogue(env)
  if (!snapshot || snapshot.fetchedAtMs === 0) return { rows: [], source: unreadSource(snapshot, env) }
  const taken = new Set<string>()
  const rows: MoonshotCatalogueRow[] = []
  const served = moonshotServedModels(env)
  for (const model of snapshot.models.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0))) {
    const id = model.id.trim().toLowerCase()
    if (id === '' || taken.has(id)) continue
    taken.add(id)
    const pin = kimiDisplayPin(id)
    const contextWindow = model.contextWindow ?? pin?.contextWindow
    const observed = served.find(record => record.requested === id && record.served !== id)
    rows.push({
      id,
      displayName: pin?.displayName ?? model.displayName ?? kimiMechanicalName(id),
      observedAt: pin?.observedAt ?? new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      listedLive: true,
      ...(observed !== undefined ? { servedAs: { id: observed.served, displayName: kimiShortName(observed.served) ?? observed.served } } : {}),
    })
  }
  return { rows: baseAliasLeads(planHeadLeads(rows)), source: { kind: 'live', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function moonshotCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { source } = moonshotCatalogueRows(env)
  return source.kind === 'live' ? `${source.count} ${source.count === 1 ? 'model' : 'models'} live` : undefined
}

export async function qualifyMoonshotModel(modelId: string): Promise<
  | { kind: 'ok'; modelId: string }
  | { kind: 'degraded'; modelId: string; note: string }
  | { kind: 'refused'; message: string }
> {
  await refreshMoonshotCatalogue()
  const snapshot = getCachedMoonshotCatalogue()
  const { rows, source } = moonshotCatalogueRows()
  if (source.kind === 'live') {
    const wanted = modelId.toLowerCase()
    if (rows.some(row => row.id === wanted)) return { kind: 'ok', modelId }
    const unprefixed = wanted.startsWith('kimi-') ? wanted.slice('kimi-'.length) : undefined
    if (unprefixed !== undefined && unprefixed !== '' && rows.some(row => row.id === unprefixed)) return { kind: 'ok', modelId: unprefixed }
    const offered = rows.map(row => row.id)
    const servedAs = moonshotAliasesServing(wanted).filter(alias => offered.includes(alias))
    return { kind: 'refused', message: modelNotOfferedByCatalogue(modelId, resolveMoonshotAccount()?.label ?? 'Moonshot account', offered, servedAs) }
  }
  return {
    kind: 'degraded', modelId,
    note: `[moonshot] the live model catalogue is unavailable${snapshot?.lastError ? ` (${snapshot.lastError})` : ''} — proceeding with '${modelId}'; the provider validates it at dispatch.`,
  }
}

export function __resetMoonshotCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
