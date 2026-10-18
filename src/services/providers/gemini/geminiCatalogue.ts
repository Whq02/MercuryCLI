import { isDeepStrictEqual } from 'node:util'
import type { ModelOption } from '../../../utils/model/modelOptions.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { getUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { GEMINI_REASONING_EFFORTS } from '../openaicompat/compatWire.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { serviceWordsOf } from '../catalogueBody.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import { declaredRouteOf } from '../routeLaw.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  geminiPlanFacts,
  geminiSourceIdentity,
  maskGeminiSecrets,
  resolveGeminiAccount,
  resolveGeminiRequestAuth,
  type GeminiAccountRef,
  type GeminiSourceKind,
} from './geminiAccounts.js'
import { fetchGeminiPlanRoster, GeminiPlanHttpError, geminiPlanTierWords, type GeminiPlanRoster } from './geminiPlanAccess.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000

export type { GeminiSourceKind }


export interface GeminiLiveModel {
  id: string
  displayName?: string
  description?: string
  version?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: readonly string[]
  thinking?: boolean
  images?: boolean
  disabled?: true
  quota?: { remainingFraction?: number; resetTime?: string }
}

export const GEMINI_PLAN_DISABLED_SUFFIX = '-disabled'
export const ANTIGRAVITY_PLAN_TABLE = 'antigravity.google/docs/models'

export function geminiPlanTierInView(): string {
  const tier = geminiPlanFacts()?.tier
  const words = geminiPlanTierWords(tier)
  return words === 'free' ? 'the free plan' : words
}

export function geminiPlanDisabledWords(model: Pick<GeminiLiveModel, 'id' | 'displayName'>, tier: string = geminiPlanTierInView()): string {
  return `withheld from ${tier} today — Google's roster names it ${model.id}${model.displayName ? ` (${model.displayName})` : ''} and answers 404 to the id; ${ANTIGRAVITY_PLAN_TABLE} says which plans include it; not offered as runnable`
}

export const GEMINI_PLAN_ROSTER_PREFIX = 'google/'

export function geminiPlanRosterId(rosterId: string): string {
  return declaredRouteOf(rosterId) === 'gemini' ? rosterId : `${GEMINI_PLAN_ROSTER_PREFIX}${rosterId}`
}

export function geminiPlanRosterModels(roster: Pick<GeminiPlanRoster, 'models' | 'imageModelIds'>): GeminiLiveModel[] {
  const images = new Set(roster.imageModelIds)
  return roster.models.map(model => ({
    id: images.has(model.id) ? model.id : geminiPlanRosterId(model.id),
    ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    ...(model.maxTokens !== undefined ? { inputTokenLimit: model.maxTokens } : {}),
    ...(model.maxOutputTokens !== undefined ? { outputTokenLimit: model.maxOutputTokens } : {}),
    supportedGenerationMethods: images.has(model.id) ? ['generateImages'] : ['generateContent'],
    ...(model.supportsThinking !== undefined ? { thinking: model.supportsThinking } : {}),
    images: model.supportsImages === true,
    ...(model.id.endsWith(GEMINI_PLAN_DISABLED_SUFFIX) ? { disabled: true as const } : {}),
    ...(model.quota !== undefined ? { quota: model.quota } : {}),
  }))
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
const CATALOGUE_ERROR_BODY_LIMIT = 600

const GOOGLE_KEY_REFUSAL = /API_KEY_INVALID|API key not valid|API key expired|API_KEY_SERVICE_BLOCKED|REFERRER_BLOCKED/

function googleErrorWords(body: string): string | undefined {
  try {
    return serviceWordsOf(JSON.parse(body)).message
  } catch {
    return undefined
  }
}

export function geminiCredentialRefused(status: number, body: string): boolean {
  return status === 401 || status === 403 || (status === 400 && GOOGLE_KEY_REFUSAL.test(body))
}

export class GeminiCatalogueHttpError extends Error {
  readonly status: number
  readonly body: string
  readonly refused: boolean
  readonly said: string | undefined
  constructor(status: number, body: string) {
    const refused = geminiCredentialRefused(status, body)
    const said = refused && status === 400 ? googleErrorWords(body) : undefined
    super(
      refused
        ? `gemini models endpoint refused the credential (HTTP ${status})${said ? ` — ${said}` : ''}`
        : `gemini models endpoint returned HTTP ${status}`,
    )
    this.name = 'GeminiCatalogueHttpError'
    this.status = status
    this.body = body
    this.refused = refused
    this.said = said
  }
}

async function catalogueErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, CATALOGUE_ERROR_BODY_LIMIT)
  } catch {
    return ''
  }
}

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
      throw new GeminiCatalogueHttpError(response.status, await catalogueErrorBody(response))
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
  lastStatus?: number
  lastSaid?: string
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
    let source: string | undefined
    try {
      const auth = await resolveGeminiRequestAuth({
        sourceKind,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts?.env ? { env: opts.env } : {}),
      })
      source = auth?.account.label
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
      const result =
        sourceKind === 'plan'
          ? await fetchGeminiPlanRoster({
              accessToken: auth.headers.authorization?.replace(/^Bearer /, '') ?? '',
              ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
              ...(opts?.env ? { env: opts.env } : {}),
              userAgent: auth.headers['user-agent'] ?? '',
            }).then(roster => ({ models: geminiPlanRosterModels(roster), fetchedAtMs: roster.fetchedAtMs }))
          : await fetchGeminiLiveModels({
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
      const answer = error instanceof GeminiCatalogueHttpError ? error : error instanceof GeminiPlanHttpError ? new GeminiCatalogueHttpError(error.status, error.body) : undefined
      if (answer !== undefined) {
        const verb = answer.refused ? 'refused the credential' : 'read failed'
        logForDebugging(
          `[gemini] catalogue ${verb} · source=${source ?? sourceKind} · HTTP ${answer.status} · body=${maskGeminiSecrets(answer.body === '' ? '(empty)' : answer.body, opts?.env)}`,
        )
      } else {
        logForDebugging(
          `[gemini] catalogue unreachable · source=${source ?? sourceKind} · ${maskGeminiSecrets(error instanceof Error ? error.message : String(error), opts?.env)}`,
        )
      }
      const lastError =
        error instanceof GeminiPlanHttpError
          ? error.status === 401 || error.status === 403
            ? `Google's Code Assist roster refused the credential (HTTP ${error.status})`
            : `Google's Code Assist roster returned HTTP ${error.status}`
          : error instanceof Error ? error.message : String(error)
      const snapshot: GeminiCatalogueSnapshot = {
        sourceKind,
        models: cached?.models ?? [],
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError,
        ...(answer !== undefined ? { lastStatus: answer.status } : {}),
        ...(answer?.said !== undefined ? { lastSaid: answer.said } : {}),
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      const settled = catalogueCache.get(identity)
      if (settled?.lastError !== cached?.lastError || !isDeepStrictEqual(settled?.models, cached?.models)) {
        bumpCatalogueEpoch()
      }
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
  const snapshot = getCachedGeminiCatalogue(account.kind, env)
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


const GEMINI_NO_CHAT_ID = /(?:^|-)(?:image|imagen|veo|tts)(?:-|$)|nano-banana/i
const GEMINI_NO_CHAT_NAME = /\bimage\b|\bimagen\b|\bveo\b|\btts\b|\bnano banana\b/i

export function geminiMakesNoChat(model: Pick<GeminiLiveModel, 'id' | 'displayName'>): boolean {
  return GEMINI_NO_CHAT_ID.test(model.id) || GEMINI_NO_CHAT_NAME.test(model.displayName ?? '')
}

export function geminiGenerateModels(snapshot: GeminiCatalogueSnapshot | null): GeminiLiveModel[] {
  if (!snapshot) return []
  return snapshot.models.filter(m => m.supportedGenerationMethods?.includes('generateContent') && m.disabled !== true && !/^(?:antigravity|deep-research)(?:-|$)/i.test(m.id) && !geminiMakesNoChat(m))
}

export function geminiGeneration(id: string): [number, number] {
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(id)
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [0, 0]
}

export function newestGeminiGenerationFirst<T>(rows: readonly T[], idOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const left = geminiGeneration(idOf(a))
    const right = geminiGeneration(idOf(b))
    return right[0] - left[0] || right[1] - left[1]
  })
}

export function geminiDisabledRosterModels(snapshot: GeminiCatalogueSnapshot | null): GeminiLiveModel[] {
  if (!snapshot) return []
  return snapshot.models.filter(m => m.disabled === true && m.supportedGenerationMethods?.includes('generateContent'))
}

export interface GeminiPlanRosterKin {
  disabled: GeminiLiveModel[]
  siblings: GeminiLiveModel[]
}

export function geminiPlanRosterKin(model: string, env: NodeJS.ProcessEnv = process.env): GeminiPlanRosterKin {
  const snapshot = getCachedGeminiCatalogue('plan', env)
  const wanted = model.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
  const bare = wanted.startsWith(GEMINI_PLAN_ROSTER_PREFIX) ? wanted.slice(GEMINI_PLAN_ROSTER_PREFIX.length) : wanted
  return {
    disabled: geminiDisabledRosterModels(snapshot).filter(m => m.id.toLowerCase() === `${bare}${GEMINI_PLAN_DISABLED_SUFFIX}` || m.id.toLowerCase() === wanted),
    siblings: geminiGenerateModels(snapshot).filter(m => m.id.toLowerCase().startsWith(`${bare}-`) || m.id.toLowerCase().startsWith(`${GEMINI_PLAN_ROSTER_PREFIX}${bare}-`)),
  }
}

export type GeminiEffortSuffix = 'low' | 'medium' | 'high'

export function geminiPlanEffortSuffix(effort: string | undefined): GeminiEffortSuffix {
  switch ((effort ?? '').trim().toLowerCase()) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    default:
      return 'high'
  }
}

export function geminiPlanEffortRow(model: string, effort: string | undefined, env: NodeJS.ProcessEnv = process.env): GeminiLiveModel | undefined {
  const bare = model.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
  if (bare === '' || declaredRouteOf(bare) !== 'gemini' || /-(?:low|medium|high)$/.test(bare)) return undefined
  const rows = geminiGenerateModels(getCachedGeminiCatalogue('plan', env))
  if (rows.length === 0 || rows.some(row => row.id.toLowerCase() === bare)) return undefined
  const want = geminiPlanEffortSuffix(effort)
  const order: GeminiEffortSuffix[] = want === 'low' ? ['low', 'medium', 'high'] : want === 'medium' ? ['medium', 'high', 'low'] : ['high', 'medium', 'low']
  for (const suffix of order) {
    const row = rows.find(candidate => candidate.id.toLowerCase() === `${bare}-${suffix}`)
    if (row) return row
  }
  return undefined
}

export function geminiPlanWireModel(model: string, effort: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return geminiPlanEffortRow(model, effort, env)?.id ?? model
}

export function geminiPlanRideWords(model: string, effort: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (resolveGeminiAccount(env)?.kind !== 'plan') return undefined
  const row = geminiPlanEffortRow(model, effort, env)
  return row === undefined ? undefined : row.id
}

export function geminiPlanRosterKinWords(kin: GeminiPlanRosterKin, tier: string = geminiPlanTierInView()): string {
  const parts: string[] = []
  for (const row of kin.disabled) parts.push(`the roster names ${row.id}${row.displayName ? ` (${row.displayName})` : ''}: withheld from ${tier} today, ${ANTIGRAVITY_PLAN_TABLE} says which plans include it`)
  if (kin.siblings.length > 0) parts.push(`the roster names ${kin.siblings.map(m => m.id).join(', ')} — /model picks one`)
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>()
const liveIdSets = new WeakMap<GeminiCatalogueSnapshot, ReadonlySet<string>>()

export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (catalogueCache.size === 0) return EMPTY_LIVE_IDS
  const account = resolveGeminiAccount(env)
  if (!account) return EMPTY_LIVE_IDS
  const snapshot = getCachedGeminiCatalogue(account.kind, env)
  if (!snapshot || snapshot.fetchedAtMs === 0 || snapshot.models.length === 0) return EMPTY_LIVE_IDS
  let ids = liveIdSets.get(snapshot)
  if (ids === undefined) {
    ids = new Set(geminiGenerateModels(snapshot).map(m => m.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function geminiCredentialRefusedReason(account: Pick<GeminiAccountRef, 'kind' | 'keySource'>, status: number | undefined, said?: string): string {
  const http = status === undefined ? '' : ` (HTTP ${status}${said ? `: ${said}` : ''})`
  if (account.kind === 'plan') return `the Google sign-in was refused by Google's Code Assist endpoint${http} · /logins signs in with Google again`
  if (account.kind === 'oauth') return `the Google account's token was refused${http} · /logins re-connects`
  if (account.keySource === 'env-google') return `the Gemini API key from GOOGLE_API_KEY was refused${http} · update GOOGLE_API_KEY`
  if (account.keySource === 'env-gemini') return `the Gemini API key from GEMINI_API_KEY was refused${http} · update GEMINI_API_KEY`
  return `the stored Gemini API key was refused${http} · /logins replaces it`
}

export function geminiCatalogueUnreachableReason(account: Pick<GeminiAccountRef, 'kind' | 'keySource'>, lastError: string): string {
  const source =
    account.kind === 'plan'
      ? 'the Google sign-in'
      : account.kind === 'oauth'
      ? 'the Google account'
      : account.keySource === 'env-google'
        ? 'the Gemini API key from GOOGLE_API_KEY'
        : account.keySource === 'env-gemini'
          ? 'the Gemini API key from GEMINI_API_KEY'
          : 'the stored Gemini API key'
  return `${source} could not reach the live catalogue (${lastError}) · retry from /model, or /model <id> names a model directly`
}

function httpStatusIn(message: string): number | undefined {
  const match = /\(HTTP (\d{3})\)/.exec(message)
  return match === null ? undefined : Number(match[1])
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
  const sourceKind: GeminiSourceKind = account.kind
  const snapshot = getCachedGeminiCatalogue(sourceKind, env)
  const verdict = catalogueTrafficVerdict('gemini', env)
  if (!verdict.allowed && (!snapshot || snapshot.models.length === 0)) {
    return { state: 'disabled', why: 'traffic-off', reason: verdict.reason }
  }
  if (!snapshot) {
    void refreshGeminiCatalogue(sourceKind, { env }).catch(() => {})
    return {
      state: 'disabled',
      why: 'catalogue-pending',
      reason: 'live catalogue not fetched yet — retry shortly',
    }
  }
  if (snapshot.models.length === 0 && snapshot.lastError) {
    void refreshGeminiCatalogue(sourceKind, { env }).catch(() => {})
    if (/refused the credential/.test(snapshot.lastError)) {
      return {
        state: 'disabled',
        why: 'auth-invalid',
        reason: geminiCredentialRefusedReason(account, snapshot.lastStatus ?? httpStatusIn(snapshot.lastError), snapshot.lastSaid),
      }
    }
    return {
      state: 'disabled',
      why: 'catalogue-error',
      reason: geminiCatalogueUnreachableReason(account, snapshot.lastError),
    }
  }
  const generate = geminiGenerateModels(snapshot)
  if (generate.length === 0) {
    return {
      state: 'disabled',
      why: 'no-generate-models',
      reason: account.kind === 'plan' ? "Google's roster names no chat model for this sign-in" : 'the live catalogue lists no generateContent-capable models for this source',
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
          ? `${connectToBrowseReason('gemini')} (Sign in with Google, an API key, or your own OAuth client) — ↵ runs /logins`
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
  const snapshot = getCachedGeminiCatalogue(availability.sourceKind, env)
  const disabledRows: ModelOption[] = geminiDisabledRosterModels(snapshot).map(model => ({
    value: model.id,
    label: model.displayName ?? model.id,
    description: '',
    descriptionForModel: `${model.displayName ?? model.id} (${model.id}) — ${geminiPlanDisabledWords(model)}.`,
    group: GEMINI_MODEL_GROUP,
    unavailable: geminiPlanDisabledWords(model),
    ...(model.inputTokenLimit !== undefined ? { statedContextWindow: model.inputTokenLimit } : {}),
  }))
  return [...geminiGenerateModels(snapshot).map(model => {
    const routed = declaredRouteOf(model.id) === 'gemini'
    const unroutableReason = `outside the routable gemini-* id space — selecting it would misroute; not selectable`
    return {
      value: model.id,
      label: model.displayName ?? model.id,
      description: '',
      descriptionForModel: availability.sourceKind === 'plan' ? `${model.displayName ?? model.id} (${model.id}) — on the roster Google serves the connected ${availability.source}${model.id.startsWith(GEMINI_PLAN_ROSTER_PREFIX) ? `; Google's own id for it is ${model.id.slice(GEMINI_PLAN_ROSTER_PREFIX.length)}, served through the Google sign-in's Code Assist endpoint, never the vendor's own lane` : ''}.` : `${model.displayName ?? model.id} (${model.id}) — live-listed generateContent model on the connected ${availability.source}.`,
      group: GEMINI_MODEL_GROUP,
      ...(wireReady && routed ? {} : { unavailable: routed ? pendingReason : unroutableReason }),
      ...(model.inputTokenLimit !== undefined ? { statedContextWindow: model.inputTokenLimit } : {}),
    }
  }), ...disabledRows]
}

export function __resetGeminiCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
