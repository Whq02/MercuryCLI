import type { ModelOption } from '../../../utils/model/modelOptions.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { getUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { GEMINI_REASONING_EFFORTS } from '../openaicompat/compatWire.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import { declaredRouteOf } from '../routeLaw.js'
import {
  geminiSourceIdentity,
  resolveGeminiAccount,
  resolveGeminiRequestAuth,
} from './geminiAccounts.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000

export type GeminiSourceKind = 'oauth' | 'api-key'


export interface GeminiLiveModel {
  id: string
  displayName?: string
  description?: string
  version?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: readonly string[]
  thinking?: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function decodeModel(raw: unknown): GeminiLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const name = str(r.name)
  if (!name) return undefined
  const id = name.startsWith('models/') ? name.slice('models/'.length) : name
  const methods = Array.isArray(r.supportedGenerationMethods)
    ? (r.supportedGenerationMethods as unknown[]).filter((m): m is string => typeof m === 'string')
    : undefined
  return {
    id,
    ...(str(r.displayName) !== undefined ? { displayName: str(r.displayName)! } : {}),
    ...(str(r.description) !== undefined ? { description: str(r.description)! } : {}),
    ...(str(r.version) !== undefined ? { version: str(r.version)! } : {}),
    ...(num(r.inputTokenLimit) !== undefined ? { inputTokenLimit: num(r.inputTokenLimit)! } : {}),
    ...(num(r.outputTokenLimit) !== undefined ? { outputTokenLimit: num(r.outputTokenLimit)! } : {}),
    ...(methods !== undefined ? { supportedGenerationMethods: methods } : {}),
    ...(typeof r.thinking === 'boolean' ? { thinking: r.thinking } : {}),
  }
}


const GEMINI_PAGE_SIZE = 1000
const GEMINI_MAX_PAGES = 5

export async function fetchGeminiLiveModels(opts: {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<{ models: GeminiLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const models: GeminiLiveModel[] = []
  let pageToken: string | undefined
  for (let page = 0; page < GEMINI_MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: String(GEMINI_PAGE_SIZE) })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await fetchWithProviderDeadline(fetchImpl, 'gemini', CATALOGUE_FETCH_TIMEOUT_MS, `${opts.baseUrl}/models?${params.toString()}`, {
      method: 'GET',
      headers: { ...opts.headers, 'user-agent': getUserAgent() },
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? `gemini models endpoint refused the credential (HTTP ${response.status})`
          : `gemini models endpoint returned HTTP ${response.status}`,
      )
    }
    const parsed = (await response.json()) as Record<string, unknown>
    const data = Array.isArray(parsed.models) ? parsed.models : []
    for (const raw of data) {
      const model = decodeModel(raw)
      if (model) models.push(model)
    }
    pageToken = str(parsed.nextPageToken)
    if (!pageToken) break
  }
  return { models, fetchedAtMs: Date.now() }
}


const GEMINI_CATALOGUE_TTL_MS = 5 * 60_000
const GEMINI_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface GeminiCatalogueSnapshot {
  sourceKind: GeminiSourceKind
  models: GeminiLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, GeminiCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<GeminiCatalogueSnapshot | null>>()

function catalogueIdentity(sourceKind: GeminiSourceKind, env?: NodeJS.ProcessEnv): string {
  return `${sourceKind}:${geminiSourceIdentity(sourceKind, env)}`
}

function storeSnapshot(identity: string, snapshot: GeminiCatalogueSnapshot): void {
  catalogueCache.set(identity, snapshot)
}

export function getCachedGeminiCatalogue(
  sourceKind: GeminiSourceKind,
  env: NodeJS.ProcessEnv = process.env,
): GeminiCatalogueSnapshot | null {
  return catalogueCache.get(catalogueIdentity(sourceKind, env)) ?? null
}

export function refreshGeminiCatalogue(
  sourceKind: GeminiSourceKind,
  opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<GeminiCatalogueSnapshot | null> {
  const now = opts?.now ?? Date.now
  const identity = catalogueIdentity(sourceKind, opts?.env)
  const cached = catalogueCache.get(identity)
  if (!catalogueTrafficVerdict('gemini', opts?.env ?? process.env).allowed) {
    return Promise.resolve(cached ?? null)
  }
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window =
    cached && cached.models.length === 0 && cached.lastError
      ? GEMINI_CATALOGUE_FAILURE_RETRY_MS
      : GEMINI_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) {
    return Promise.resolve(cached)
  }
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<GeminiCatalogueSnapshot | null> => {
    try {
      const auth = await resolveGeminiRequestAuth({
        sourceKind,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts?.env ? { env: opts.env } : {}),
      })
      if (!auth) {
        const snapshot: GeminiCatalogueSnapshot = {
          sourceKind,
          models: cached?.models ?? [],
          fetchedAtMs: cached?.fetchedAtMs ?? 0,
          lastAttemptAtMs: now(),
          lastError: 'account-source-unavailable',
        }
        storeSnapshot(identity, snapshot)
        return snapshot
      }
      const result = await fetchGeminiLiveModels({
        baseUrl: auth.baseUrl,
        headers: auth.headers,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: GeminiCatalogueSnapshot = {
        sourceKind,
        models: result.models,
        fetchedAtMs: result.fetchedAtMs,
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: GeminiCatalogueSnapshot = {
        sourceKind,
        models: cached?.models ?? [],
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      bumpCatalogueEpoch()
    }
  })()
  catalogueInFlight.set(identity, work)
  return work
}


export function geminiListedModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): GeminiLiveModel | undefined {
  if (declaredRouteOf(model) !== 'gemini') return undefined
  const account = resolveGeminiAccount(env)
  if (!account) return undefined
  const snapshot = getCachedGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key')
  if (!snapshot || snapshot.models.length === 0) return undefined
  const id = model.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
  return snapshot.models.find(m => m.id.toLowerCase() === id)
}

export function geminiContextWindowFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { window: number; source: 'live-current' } | undefined {
  const listed = geminiListedModel(model, env)
  return listed?.inputTokenLimit !== undefined && listed.inputTokenLimit > 0
    ? { window: listed.inputTokenLimit, source: 'live-current' }
    : undefined
}

export function geminiOutputTokenLimitFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const listed = geminiListedModel(model, env)
  return listed?.outputTokenLimit !== undefined && listed.outputTokenLimit > 0
    ? listed.outputTokenLimit
    : undefined
}

export function geminiEffortVocabularyFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return geminiListedModel(model, env)?.thinking === true ? GEMINI_REASONING_EFFORTS : []
}


export type GeminiDisabledWhy =
  | 'no-account'
  | 'auth-invalid'
  | 'catalogue-pending'
  | 'catalogue-error'
  | 'no-generate-models'
  | 'traffic-off'

export type GeminiAvailability =
  | { state: 'disabled'; why: GeminiDisabledWhy; reason: string }
  | {
      state: 'ready'
      ids: string[]
      source: string
      sourceKind: GeminiSourceKind
      fetchedAtMs: number
    }


export function geminiGenerateModels(snapshot: GeminiCatalogueSnapshot | null): GeminiLiveModel[] {
  if (!snapshot) return []
  return snapshot.models.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
}

export function getGeminiAvailability(env: NodeJS.ProcessEnv = process.env): GeminiAvailability {
  const account = resolveGeminiAccount(env)
  if (!account) {
    return {
      state: 'disabled',
      why: 'no-account',
      reason: `${connectToBrowseReason('gemini')} — /logins connects`,
    }
  }
  const sourceKind: GeminiSourceKind = account.kind === 'oauth' ? 'oauth' : 'api-key'
  const snapshot = getCachedGeminiCatalogue(sourceKind)
  const verdict = catalogueTrafficVerdict('gemini', env)
  if (!verdict.allowed && (!snapshot || snapshot.models.length === 0)) {
    return { state: 'disabled', why: 'traffic-off', reason: verdict.reason }
  }
  if (!snapshot) {
    void refreshGeminiCatalogue(sourceKind).catch(() => {})
    return {
      state: 'disabled',
      why: 'catalogue-pending',
      reason: 'live catalogue not fetched yet — retry shortly',
    }
  }
  if (snapshot.models.length === 0 && snapshot.lastError) {
    void refreshGeminiCatalogue(sourceKind).catch(() => {})
    if (/refused the credential/.test(snapshot.lastError)) {
      return {
        state: 'disabled',
        why: 'auth-invalid',
        reason: 'the Gemini credential was refused — /logins re-connects',
      }
    }
    return {
      state: 'disabled',
      why: 'catalogue-error',
      reason: `live catalogue unreachable (${snapshot.lastError})`,
    }
  }
  const generate = geminiGenerateModels(snapshot)
  if (generate.length === 0) {
    return {
      state: 'disabled',
      why: 'no-generate-models',
      reason: 'the live catalogue lists no generateContent-capable models for this source',
    }
  }
  return {
    state: 'ready',
    ids: generate.map(m => m.id),
    source: account.label,
    sourceKind,
    fetchedAtMs: snapshot.fetchedAtMs,
  }
}


export const GEMINI_MODEL_GROUP = 'Mercury — Gemini models'
export const GEMINI_CONNECT_OPTION_VALUE = '__mercury_gemini_connect__'

export function geminiDispatchReady(
  route: (model: string) => string | null = declaredRouteOf,
): boolean {
  return route('gemini-2.5-pro') === 'gemini'
}

export function getGeminiModelOptions(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const availability = getGeminiAvailability(env)
  if (availability.state === 'disabled') {
    const signIn = availability.why === 'no-account' || availability.why === 'auth-invalid'
    return [
      {
        value: GEMINI_CONNECT_OPTION_VALUE,
        label: signIn
          ? 'Gemini — sign in'
          : availability.why === 'traffic-off'
            ? 'Gemini — catalogue off'
            : availability.why === 'catalogue-error'
              ? 'Gemini — catalogue unreachable'
              : availability.why === 'no-generate-models'
                ? 'Gemini — no chat models served'
                : 'Gemini — connecting…',
        description: signIn
          ? `${connectToBrowseReason('gemini')} (API key or Google OAuth) — ↵ runs /logins`
          : availability.why === 'traffic-off'
            ? availability.reason
            : `rows appear when the live catalogue lands (${availability.reason})${availability.why === 'catalogue-pending' ? ' — ↵ retries now' : ''}`,
        descriptionForModel:
          availability.why === 'traffic-off'
            ? `Catalogue traffic is switched off (${availability.reason}); no model-list request is made and the live-only Gemini list stays empty until it is re-enabled.`
            : 'The Gemini group is not connected — no catalogue is fetched while signed out; the operator signs in with /logins and the model list then derives live from the Gemini models endpoint.',
        group: GEMINI_MODEL_GROUP,
      },
    ]
  }
  const wireReady = geminiDispatchReady()
  const pendingReason = 'dispatch wire pending — the provider-wire fold routes Gemini turns'
  const snapshot = getCachedGeminiCatalogue(availability.sourceKind)
  return geminiGenerateModels(snapshot).map(model => {
    const routed = declaredRouteOf(model.id) === 'gemini'
    const unroutableReason = `outside the routable gemini-* id space — selecting it would misroute; not selectable`
    return {
      value: model.id,
      label: model.displayName ?? model.id,
      description: '',
      descriptionForModel: `${model.displayName ?? model.id} (${model.id}) — live-listed generateContent model on the connected ${availability.source}.`,
      group: GEMINI_MODEL_GROUP,
      ...(wireReady && routed ? {} : { unavailable: routed ? pendingReason : unroutableReason }),
      ...(model.inputTokenLimit !== undefined ? { statedContextWindow: model.inputTokenLimit } : {}),
    }
  })
}

export function __resetGeminiCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
