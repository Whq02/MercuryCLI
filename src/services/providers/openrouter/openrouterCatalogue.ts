// ============================================================================
//  providers/openrouter/openrouterCatalogue — the LIVE OpenRouter catalogue
//
//
//  THE TRUTH DOCTRINE: OpenRouter fronts a 400+ model multi-vendor catalogue
//  that changes weekly — there is NO static pin table here at all. Which
//  models exist is ONLY ever the live endpoint's answer, cached bounded +
//  TTL'd + stale-but-labelled (the openaiCatalogue discipline); an
//  unconnected or unfetched lane renders honest absence, never an invented
//  list.
//
//  Wire (probed live UNAUTHENTICATED + openrouter.ai/docs/guides/overview/
//  models, both):
//    GET {api}/models answers WITHOUT auth (the lane still sends its
//    credential — a keyed view may differ); query: sort (most-popular ·
//    newest · pricing-low-to-high · …), output_modalities, limit (default
//    500, MAX 1000 — observed honored: the full 423-row catalogue arrived
//    in one limit=1000 page), offset; response { data: Model[],
//    total_count, links: { next } } where next is a ready-to-use URL
//    (observed RELATIVE), null on the last page. Pagination is opt-in;
//    a page stating more rows without a follow URL is labelled truncation,
//    never a silently short list. Model fields: id ('vendor/slug'), canonical_slug,
//    name, created (unix s), description, context_length, architecture
//    { input_modalities, output_modalities, tokenizer, instruct_type },
//    pricing { prompt, completion, request, … }, top_provider
//    { context_length, max_completion_tokens, is_moderated },
//    supported_parameters[], default_parameters, expiration_date,
//    per_request_limits. Only STATED fields are decoded — absent ≠ zero.
//
//  The picker consumes the vendor's OWN most-popular ordering (a live
//  ranking, never a Mercury guess) and bounds the rendered rows behind a
//  DOOR row that expands the group to the full list with a filter; the full
//  list rides the snapshot for every other surface, and
//  openrouterModelsForVendor() is the mechanical seam the future
//  smart-reroute lane consults ("does the connected OpenRouter credential
//  serve vendor X right now").
// ============================================================================
import type { ModelOption } from '../../../utils/model/modelOptions.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import {
  canonicalWireModelId,
  healListedCatalogueRowId,
  qualifiedWireId,
  declaredRouteOf,
} from '../routeLaw.js'
import { OPENROUTER_REASONING_EFFORTS } from '../openaicompat/compatWire.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import {
  openrouterApiBase,
  resolveOpenrouterRequestAuth,
  type OpenrouterKeySource,
} from './openrouterAccounts.js'

// ── The decoded live model (stated fields only) ─────────────────────────────

/** One deadline per catalogue page request (the provider-call deadline law). */
const CATALOGUE_FETCH_TIMEOUT_MS = 15_000

export interface OpenrouterLiveModel {
  /** Vendor-prefixed slug, e.g. 'google/gemini-2.5-pro'. */
  id: string
  name?: string
  description?: string
  contextLength?: number
  /** As stated by the endpoint (string costs per token) — verbatim facts,
   *  parsed only where a consumer needs arithmetic. The cache-read and
   *  cache-write rates ride along where the row states them: the ledger's
   *  OpenRouter pricing owner (utils/modelCost) prices a turn the wire did
   *  not price from THIS row, never from another vendor's tier. */
  pricing?: {
    prompt?: string
    completion?: string
    request?: string
    inputCacheRead?: string
    inputCacheWrite?: string
  }
  supportedParameters?: readonly string[]
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
  maxCompletionTokens?: number
  /** Stated deprecation date — a model on its way out says so. */
  expirationDate?: string
  createdAtS?: number
  /** The row's stated reasoning contract (openrouter.ai/docs/use-cases/
   *  reasoning-tokens, fetched 2026-08-25): "Each model in GET /api/v1/models
   *  may include a `reasoning` object describing which effort levels it
   *  accepts and whether reasoning is mandatory"; non-reasoning models and
   *  dynamic routers omit it. Only stated fields land. */
  reasoning?: {
    supportedEfforts?: readonly string[]
    defaultEffort?: string
    enabledByDefault?: boolean
    mandatory?: boolean
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
}

function decodeModel(raw: unknown): OpenrouterLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return undefined
  const architecture =
    typeof r.architecture === 'object' && r.architecture !== null
      ? (r.architecture as Record<string, unknown>)
      : undefined
  const pricing =
    typeof r.pricing === 'object' && r.pricing !== null
      ? (r.pricing as Record<string, unknown>)
      : undefined
  const topProvider =
    typeof r.top_provider === 'object' && r.top_provider !== null
      ? (r.top_provider as Record<string, unknown>)
      : undefined
  const decodedPricing = pricing
    ? {
        ...(str(pricing.prompt) !== undefined ? { prompt: str(pricing.prompt)! } : {}),
        ...(str(pricing.completion) !== undefined ? { completion: str(pricing.completion)! } : {}),
        ...(str(pricing.request) !== undefined ? { request: str(pricing.request)! } : {}),
        ...(str(pricing.input_cache_read) !== undefined ? { inputCacheRead: str(pricing.input_cache_read)! } : {}),
        ...(str(pricing.input_cache_write) !== undefined ? { inputCacheWrite: str(pricing.input_cache_write)! } : {}),
      }
    : undefined
  const reasoningRaw =
    typeof r.reasoning === 'object' && r.reasoning !== null
      ? (r.reasoning as Record<string, unknown>)
      : undefined
  const reasoning = reasoningRaw
    ? {
        ...(strArray(reasoningRaw.supported_efforts) !== undefined
          ? { supportedEfforts: strArray(reasoningRaw.supported_efforts)! }
          : {}),
        ...(str(reasoningRaw.default_effort) !== undefined
          ? { defaultEffort: str(reasoningRaw.default_effort)! }
          : {}),
        ...(typeof reasoningRaw.default_enabled === 'boolean'
          ? { enabledByDefault: reasoningRaw.default_enabled }
          : {}),
        ...(typeof reasoningRaw.mandatory === 'boolean' ? { mandatory: reasoningRaw.mandatory } : {}),
      }
    : undefined
  return {
    id,
    ...(str(r.name) !== undefined ? { name: str(r.name)! } : {}),
    ...(str(r.description) !== undefined ? { description: str(r.description)! } : {}),
    ...(num(r.context_length) !== undefined ? { contextLength: num(r.context_length)! } : {}),
    ...(decodedPricing && Object.keys(decodedPricing).length > 0 ? { pricing: decodedPricing } : {}),
    ...(strArray(r.supported_parameters) !== undefined
      ? { supportedParameters: strArray(r.supported_parameters)! }
      : {}),
    ...(strArray(architecture?.input_modalities) !== undefined
      ? { inputModalities: strArray(architecture?.input_modalities)! }
      : {}),
    ...(strArray(architecture?.output_modalities) !== undefined
      ? { outputModalities: strArray(architecture?.output_modalities)! }
      : {}),
    ...(num(topProvider?.max_completion_tokens) !== undefined
      ? { maxCompletionTokens: num(topProvider?.max_completion_tokens)! }
      : {}),
    ...(str(r.expiration_date) !== undefined ? { expirationDate: str(r.expiration_date)! } : {}),
    ...(num(r.created) !== undefined ? { createdAtS: num(r.created)! } : {}),
    ...(reasoning && Object.keys(reasoning).length > 0 ? { reasoning } : {}),
  }
}

// ── The live fetch (bounded pagination; the vendor's most-popular order) ────

const OPENROUTER_PAGE_LIMIT = 1000
const OPENROUTER_MAX_PAGES = 5

export async function fetchOpenrouterLiveModels(opts: {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<{ models: OpenrouterLiveModel[]; fetchedAtMs: number; incomplete?: string }> {
  // PROVIDER-REVIEW F2: paired client, never bare global fetch (undici law).
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const models: OpenrouterLiveModel[] = []
  let incomplete: string | undefined
  // sort=most-popular is the vendor's OWN live ranking (documented sort
  // option) — the bounded picker rows ride it instead of a Mercury guess.
  let url = `${opts.baseUrl}/models?limit=${OPENROUTER_PAGE_LIMIT}&sort=most-popular`
  for (let page = 0; page < OPENROUTER_MAX_PAGES && url; page++) {
    // The provider-call deadline law: a black-holed origin ends within the
    // bound with the honest line, never a spinner held open.
    const response = await fetchWithProviderDeadline(fetchImpl, 'openrouter', CATALOGUE_FETCH_TIMEOUT_MS, url, {
      method: 'GET',
      headers: { ...opts.headers, 'user-agent': getProductUserAgent() },
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? `openrouter models endpoint refused the credential (HTTP ${response.status})`
          : `openrouter models endpoint returned HTTP ${response.status}`,
      )
    }
    const parsed = (await response.json()) as Record<string, unknown>
    const data = Array.isArray(parsed.data) ? parsed.data : []
    for (const raw of data) {
      const model = decodeModel(raw)
      if (model) models.push(model)
    }
    const links =
      typeof parsed.links === 'object' && parsed.links !== null
        ? (parsed.links as Record<string, unknown>)
        : undefined
    const next = str(links?.next)
    if (!next && parsed.has_more === true) {
      // A cursor-shaped page (has_more without a follow URL) states more
      // rows this client cannot honestly fetch — label the truncation
      // instead of serving a silently short list.
      incomplete = 'catalogue page signalled has_more without links.next — rows beyond this page were not fetched'
    }
    url = next ? (next.startsWith('http') ? next : `${opts.baseUrl.replace(/\/api\/v1$/, '')}${next}`) : ''
  }
  if (url) {
    incomplete = `catalogue pagination stopped at the ${OPENROUTER_MAX_PAGES}-page bound with pages remaining`
  }
  if (models.length > 0) {
    // FEED-SHAPE GATE: a non-empty page where no listed id is a dispatchable
    // openrouter id is NOT the catalogue — it is some other view answering on
    // the catalogue URL (agent-compatibility surfaces do exactly this).
    // Refusing here routes the refresh into the labelled-failure channel:
    // prior rows stay stale-but-labelled, junk never becomes the snapshot.
    const clean = models.filter(m => {
      const verdict = canonicalWireModelId(`openrouter/${m.id}`)
      return verdict.ok && verdict.healed !== true
    })
    if (clean.length === 0) {
      throw new Error(
        `the models endpoint answered a non-catalogue view (0/${models.length} listed ids are dispatchable) — a compatibility surface, not the live catalogue`,
      )
    }
  }
  return { models, fetchedAtMs: Date.now(), ...(incomplete ? { incomplete } : {}) }
}

// ── The bounded snapshot cache (per key source; TTL'd; single-flight) ───────

const OPENROUTER_CATALOGUE_TTL_MS = 5 * 60_000
const OPENROUTER_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface OpenrouterCatalogueSnapshot {
  keySource: OpenrouterKeySource
  models: OpenrouterLiveModel[]
  /** When the MODELS were actually fetched (0 = never) — the staleness label. */
  fetchedAtMs: number
  lastAttemptAtMs?: number
  /** Set when the last refresh failed — the stale-but-labelled channel. */
  lastError?: string
}

const catalogueCache = new Map<string, OpenrouterCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<OpenrouterCatalogueSnapshot | null>>()

/** Every snapshot write is a context-window-source change: the stated
 *  context_length rows decide an openrouter id's budget (capabilities.ts). */
function storeSnapshot(identity: string, snapshot: OpenrouterCatalogueSnapshot): void {
  catalogueCache.set(identity, snapshot)
}

/** The snapshot identity: source + credential fingerprint + base. A new
 *  minted key, a different stored key, or a base change is a NEW catalogue —
 *  a snapshot never outlives the credential that fetched it. The fingerprint
 *  is a non-reversible digest; the key value itself never leaves the auth
 *  owner. */
function catalogueIdentity(
  keySource: OpenrouterKeySource,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth || auth.account.keySource !== keySource) return `${keySource}:none`
  return `${keySource}:${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}`
}

/** Sync cache read — free; null when never fetched (or fetched by a
 *  credential that is no longer the active one). */
export function getCachedOpenrouterCatalogue(
  keySource: OpenrouterKeySource,
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterCatalogueSnapshot | null {
  return catalogueCache.get(catalogueIdentity(keySource, env)) ?? null
}

/** Async refresh honoring the TTL (force bypasses). Single-flight per key
 *  source. Failures label the cache, never throw. */
export function refreshOpenrouterCatalogue(
  keySource: OpenrouterKeySource,
  opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<OpenrouterCatalogueSnapshot | null> {
  const now = opts?.now ?? Date.now
  const identity = catalogueIdentity(keySource, opts?.env)
  const cached = catalogueCache.get(identity)
  // THE DOOR (catalogueGate): no credential, or catalogue traffic switched
  // off, means NO request — a non-event (no snapshot write, no epoch bump);
  // whatever is cached keeps serving, labelled as it stands.
  if (!catalogueTrafficVerdict('openrouter', opts?.env ?? process.env).allowed) {
    return Promise.resolve(cached ?? null)
  }
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window =
    cached && cached.models.length === 0 && cached.lastError
      ? OPENROUTER_CATALOGUE_FAILURE_RETRY_MS
      : OPENROUTER_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) {
    return Promise.resolve(cached)
  }
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<OpenrouterCatalogueSnapshot | null> => {
    try {
      const auth = resolveOpenrouterRequestAuth(opts?.env ?? process.env)
      if (!auth || auth.account.keySource !== keySource) {
        const snapshot: OpenrouterCatalogueSnapshot = {
          keySource,
          models: cached?.models ?? [],
          fetchedAtMs: cached?.fetchedAtMs ?? 0,
          lastAttemptAtMs: now(),
          lastError: 'account-source-unavailable',
        }
        storeSnapshot(identity, snapshot)
        return snapshot
      }
      const result = await fetchOpenrouterLiveModels({
        baseUrl: auth.baseUrl,
        headers: auth.headers,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: OpenrouterCatalogueSnapshot = {
        keySource,
        models: result.models,
        fetchedAtMs: result.fetchedAtMs,
        // Stale-but-labelled: an incomplete page walk keeps its rows AND
        // says so — consumers read lastError beside fetchedAtMs.
        ...(result.incomplete ? { lastError: result.incomplete } : {}),
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: OpenrouterCatalogueSnapshot = {
        keySource,
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

// ── Availability (the honest chain the picker + surfaces derive from) ───────

export type OpenrouterDisabledWhy =
  | 'no-account'
  | 'auth-invalid'
  | 'catalogue-pending'
  | 'catalogue-error'
  | 'no-models'
  /** Credentialed, but MERCURY_DISABLE_NONESSENTIAL_TRAFFIC keeps the
   *  live-only catalogue dark — nothing to list, and no request made. */
  | 'traffic-off'

export type OpenrouterAvailability =
  | { state: 'disabled'; why: OpenrouterDisabledWhy; reason: string }
  | {
      state: 'ready'
      /** Live ids in the vendor's most-popular order. */
      ids: string[]
      modelCount: number
      /** Account-source label (billing honesty). */
      source: string
      keySource: OpenrouterKeySource
      /** The snapshot's fetch stamp — every consumer can label staleness. */
      fetchedAtMs: number
    }

export function getOpenrouterAvailability(
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterAvailability {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) {
    return {
      state: 'disabled',
      why: 'no-account',
      reason: `${connectToBrowseReason('openrouter')} — /logins connects`,
    }
  }
  const keySource = auth.account.keySource
  const snapshot = getCachedOpenrouterCatalogue(keySource)
  const verdict = catalogueTrafficVerdict('openrouter', env)
  if (!verdict.allowed && (!snapshot || snapshot.models.length === 0)) {
    // Credentialed but dark, with nothing cached to show: the catalogue is
    // live-only, so the honest state names the switch — never a "retry
    // shortly" whose retry the door would refuse.
    return { state: 'disabled', why: 'traffic-off', reason: verdict.reason }
  }
  if (!snapshot) {
    void refreshOpenrouterCatalogue(keySource).catch(() => {})
    return {
      state: 'disabled',
      why: 'catalogue-pending',
      reason: 'live catalogue not fetched yet — retry shortly',
    }
  }
  if (snapshot.models.length === 0 && snapshot.lastError) {
    void refreshOpenrouterCatalogue(keySource).catch(() => {})
    if (/refused the credential/.test(snapshot.lastError)) {
      return {
        state: 'disabled',
        why: 'auth-invalid',
        reason: 'the OpenRouter credential was refused — /logins re-connects',
      }
    }
    const overrideBase = env['MERCURY_OPENROUTER_API_BASE']?.trim()
    return {
      state: 'disabled',
      why: 'catalogue-error',
      reason: `live catalogue unreachable (${snapshot.lastError})${overrideBase ? ` · base override ${overrideBase}` : ''}`,
    }
  }
  if (snapshot.models.length === 0) {
    // The gemini no-generate-models arm: a connected credential whose live
    // catalogue answered with zero rows names that state — never a bare
    // "ready" over an empty list.
    return {
      state: 'disabled',
      why: 'no-models',
      reason: 'the live catalogue listed no models for this credential',
    }
  }
  const overrideBase = env['MERCURY_OPENROUTER_API_BASE']?.trim()
  return {
    state: 'ready',
    ids: snapshot.models.map(m => m.id),
    modelCount: snapshot.models.length,
    // The base-override proof seam is LOUD when armed: every surface that
    // labels the source names the non-production base serving the rows.
    source: overrideBase
      ? `${auth.account.label} · base override ${overrideBase}`
      : auth.account.label,
    keySource,
    fetchedAtMs: snapshot.fetchedAtMs,
  }
}

// ── The smart-reroute seam (mechanical; no class guessing) ──────────────────

/** Live models served under one vendor prefix (e.g. 'anthropic', 'openai',
 *  'google') for the ACTIVE credential's cached catalogue — the fallback-tier
 *  question a reroute lane asks. Empty when unfetched/absent (the caller
 *  refreshes if it wants a current answer). */
export function openrouterModelsForVendor(
  vendor: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterLiveModel[] {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return []
  const snapshot = getCachedOpenrouterCatalogue(auth.account.keySource)
  if (!snapshot) return []
  const prefix = `${vendor.toLowerCase().replace(/\/+$/, '')}/`
  return snapshot.models.filter(m => m.id.toLowerCase().startsWith(prefix))
}

// ── Per-model stated facts (the capability edge + the wire read these) ─────
//
//  A persisted openrouter/<vendor>/<model> id carries the VENDOR's identity:
//  its window, output ceiling and reasoning dial are whatever the live row
//  states — never a first-party family's table joined by substring (the
//  class where every carrier row budgeted the Anthropic 200k default, or
//  a Claude slug behind the carrier lit a 1M pin the carrier never served).
//  Absent ⇒ undefined: the caller falls to its labelled conservative
//  default, never an invented number.

/** The listed row for a persisted id (namespace detached, annotations
 *  stripped, case-insensitive) from the ACTIVE credential's cached
 *  catalogue; undefined when unfetched or unlisted. */
export function openrouterListedModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenrouterLiveModel | undefined {
  if (declaredRouteOf(model) !== 'openrouter') return undefined
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return undefined
  const snapshot = getCachedOpenrouterCatalogue(auth.account.keySource, env)
  if (!snapshot || snapshot.models.length === 0) return undefined
  const verdict = canonicalWireModelId(model)
  const slug = (verdict.ok ? verdict.wireId : qualifiedWireId(model)).toLowerCase()
  return snapshot.models.find(m => m.id.toLowerCase() === slug)
}

/** The context window the live row states (`context_length`), else
 *  undefined. The source word lets the resolver label it. */
export function openrouterContextWindowFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { window: number; source: 'live-current' } | undefined {
  const listed = openrouterListedModel(model, env)
  return listed?.contextLength !== undefined && listed.contextLength > 0
    ? { window: listed.contextLength, source: 'live-current' }
    : undefined
}

/** The output ceiling the live row states (`top_provider.max_completion_tokens`). */
export function openrouterMaxCompletionTokensFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const listed = openrouterListedModel(model, env)
  return listed?.maxCompletionTokens !== undefined && listed.maxCompletionTokens > 0
    ? listed.maxCompletionTokens
    : undefined
}

/** The reasoning-effort vocabulary the live row ACCEPTS, in Mercury's
 *  rankable spellings: the row's stated `reasoning.supported_efforts` when
 *  it states one; else the documented full ladder when the row lists
 *  `reasoning` among its supported_parameters; else EMPTY — no dial is
 *  offered and none is sent (absent beats invented). Unfetched/unlisted ⇒
 *  empty for the same reason. */
export function openrouterEffortVocabularyFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const listed = openrouterListedModel(model, env)
  if (!listed) return []
  const stated = listed.reasoning?.supportedEfforts
  if (stated !== undefined) {
    return stated.filter(level => OPENROUTER_REASONING_EFFORTS.includes(level))
  }
  return listed.supportedParameters?.includes('reasoning') ? OPENROUTER_REASONING_EFFORTS : []
}

// ── Dispatch readiness + the /model picker rows ─────────────────────────────

/** The picker group heading (the OPENAI_MODEL_GROUP grammar). */
export const OPENROUTER_MODEL_GROUP = 'Mercury — OpenRouter models'
/** The connect action sentinel (a picker ACTION, never a model). */
export const OPENROUTER_CONNECT_OPTION_VALUE = '__mercury_openrouter_connect__'
/** The catalogue DOOR sentinel (a picker ACTION, never a model): the row
 *  past the bound whose ↵ expands the group to the full live list behind a
 *  type-to-filter line (isCatalogueDoorRow shape-matches it). */
export const OPENROUTER_EXPAND_OPTION_VALUE = '__mercury_openrouter_expand__'

/** How many live rows the picker renders before the door (the vendor's
 *  most-popular order); the door expands to every row the snapshot holds
 *  (getOpenrouterFullModelOptions), and the snapshot accessors serve every
 *  other surface. */
const OPENROUTER_PICKER_ROW_BOUND = 24

/**
 * TRUE once the routing law recognizes OpenRouter's vendor-slug ids — the
 * one-predicate flip the provider-wire fold performs. Probing the REAL
 * routing law (never a local copy) keeps the picker's selectability and the
 * dispatch path mechanically agreed: while declaredRouteOf would still
 * send a slug down the Anthropic lane, every OpenRouter row stays
 * visible-but-unavailable (selecting one would dispatch to the wrong
 * provider — the no-cross-provider-fallback law).
 */
export function openrouterDispatchReady(
  route: (model: string) => string | null = declaredRouteOf,
): boolean {
  return route('openrouter/auto') === 'openrouter'
}

/** The /model picker rows for the OpenRouter lane. Signed-out states render
 *  the ONE action row (↵ routes to /logins / retries the fetch) — there are
 *  no invented pins to show behind it; the catalogue is live-only. */
export function getOpenrouterModelOptions(
  env: NodeJS.ProcessEnv = process.env,
): ModelOption[] {
  const availability = getOpenrouterAvailability(env)
  if (availability.state === 'disabled') {
    const signIn = availability.why === 'no-account' || availability.why === 'auth-invalid'
    return [
      {
        value: OPENROUTER_CONNECT_OPTION_VALUE,
        label: signIn
          ? 'OpenRouter — sign in'
          : availability.why === 'traffic-off'
            ? 'OpenRouter — catalogue off'
            : availability.why === 'catalogue-error'
              ? 'OpenRouter — catalogue unreachable'
              : availability.why === 'no-models'
                ? 'OpenRouter — no models listed'
                : 'OpenRouter — connecting…',
        description: signIn
          ? `${connectToBrowseReason('openrouter')} — ↵ runs /logins`
          : availability.why === 'traffic-off'
            ? availability.reason
            : `rows appear when the live catalogue lands (${availability.reason}) — ↵ retries now`,
        descriptionForModel:
          availability.why === 'traffic-off'
            ? `Catalogue traffic is switched off (${availability.reason}); no model-list request is made and the live-only OpenRouter list stays empty until it is re-enabled.`
            : 'The OpenRouter group is not connected — no catalogue is fetched while signed out; the operator signs in with /logins and the model list then derives live from the OpenRouter catalogue.',
        group: OPENROUTER_MODEL_GROUP,
      },
    ]
  }
  const wireReady = openrouterDispatchReady()
  const rows: ModelOption[] = []
  const snapshot = getCachedOpenrouterCatalogue(availability.keySource, env)
  const models = snapshot?.models ?? []
  if (snapshot?.lastError && snapshot.fetchedAtMs > 0) {
    // Stale-but-labelled, SURFACED: the rows below derive from a snapshot
    // whose refresh is failing — the screen says so instead of wearing
    // stale rows as live ones.
    const ageMin = Math.max(1, Math.round((Date.now() - snapshot.fetchedAtMs) / 60_000))
    rows.push({
      value: OPENROUTER_CONNECT_OPTION_VALUE,
      label: `OpenRouter — catalogue stale (${ageMin}m)`,
      description: `last refresh failed: ${snapshot.lastError} — ↵ retries now`,
      descriptionForModel: `The OpenRouter rows derive from a snapshot ${ageMin} minute(s) old; the last live refresh failed (${snapshot.lastError}).`,
      group: OPENROUTER_MODEL_GROUP,
    })
  }
  rows.push(...openrouterCatalogueRows(models, availability.source, wireReady, OPENROUTER_PICKER_ROW_BOUND))
  if (availability.modelCount > OPENROUTER_PICKER_ROW_BOUND) {
    // THE DOOR: the rows past the bound are one ↵ away — the picker expands
    // the group in place to the full live list (the same builder, unbounded)
    // behind a filter line; the copy says exactly that. The count is the
    // availability's (the snapshot's row count), and the row is an ACTION
    // (never a model, never counted as one).
    rows.push({
      value: OPENROUTER_EXPAND_OPTION_VALUE,
      label: `OpenRouter — ${availability.modelCount} models live`,
      description: `↵ expand · ${availability.modelCount} live · type to filter`,
      descriptionForModel: `The connected OpenRouter credential serves ${availability.modelCount} live models; the picker renders the top ${OPENROUTER_PICKER_ROW_BOUND} by the vendor's own most-popular ranking, and this row expands the group to the full list behind a filter — any listed id also dispatches when typed as openrouter/<vendor>/<model>.`,
      group: OPENROUTER_MODEL_GROUP,
      catalogueDoor: { family: 'OpenRouter', total: availability.modelCount },
    })
  }
  return rows
}

/** EVERY snapshot row as picker rows — the door's expanded list: the same
 *  builder as the bounded view (healed and deduped the same way, the
 *  vendor's order), unbounded. Empty unless the lane is ready. */
export function getOpenrouterFullModelOptions(
  env: NodeJS.ProcessEnv = process.env,
): ModelOption[] {
  const availability = getOpenrouterAvailability(env)
  if (availability.state !== 'ready') return []
  const models = getCachedOpenrouterCatalogue(availability.keySource, env)?.models ?? []
  return openrouterCatalogueRows(models, availability.source, openrouterDispatchReady(), models.length)
}

/** The ONE picker-row builder over the snapshot's models: the first `bound`
 *  rows in the vendor's order, each adjudicated by the wire-id owner and
 *  healed against the WHOLE listed catalogue. The bounded picker view and
 *  the door's full list both derive here, so a row reads the same at both
 *  depths. */
function openrouterCatalogueRows(
  models: OpenrouterLiveModel[],
  source: string,
  wireReady: boolean,
  bound: number,
): ModelOption[] {
  const rows: ModelOption[] = []
  const pendingReason = 'dispatch wire pending — the provider-wire fold routes OpenRouter turns'
  // The heal adjudicates against the WHOLE listed catalogue (not the
  // rendered slice): a junk-shaped row whose clean twin is listed anywhere
  // heals onto that twin's id.
  const listedIds = new Set(models.map(m => m.id))
  const byId = new Map(models.map(m => [m.id, m]))
  const emitted = new Set<string>()
  for (const model of models.slice(0, bound)) {
    // PERSISTED ids are provider-QUALIFIED (provwire namespacing ruling,
    // 'openrouter/<full-vendor-slug>' — bare vendor slugs are
    // deliberately unrecognized by the routing law (they would collide with
    // the compat slot and need an unbounded vendor list); the wire strips
    // the namespace back to the vendor slug (qualifiedWireId). The row copy
    // keeps showing the VENDOR's own slug — that is the catalogue truth.
    //
    // ROW TRUTH FIRST (the live poisoned-feed class): the wire owner
    // adjudicates the raw spelling; a rejected row id — Mercury dressing or
    // a spurious leading vendor segment — HEALS onto its LISTED clean twin
    // (the row renders and persists the vendor's own id; duplicate healed
    // rows collapse). Junk with no listed twin renders
    // visible-but-unavailable, and the wire owner refuses it at every later
    // seam; junk never persists as a selection either way.
    const rawVerdict = canonicalWireModelId(`openrouter/${model.id}`)
    const rowClean = rawVerdict.ok && rawVerdict.healed !== true
    const healed = rowClean ? model.id : healListedCatalogueRowId(model.id, listedIds)
    if (healed !== undefined && healed !== model.id) {
      if (emitted.has(healed)) continue
      const twin = byId.get(healed) ?? model
      emitted.add(healed)
      rows.push({
        value: `openrouter/${healed}`,
        label: twin.name ?? healed,
        description: '',
        descriptionForModel: `${twin.name ?? healed} (${healed}) — served through the connected ${source}, live-listed by the OpenRouter catalogue (most-popular order); persisted as openrouter/${healed}.`,
        group: OPENROUTER_MODEL_GROUP,
        ...(wireReady ? {} : { unavailable: pendingReason }),
        ...(twin.contextLength !== undefined ? { statedContextWindow: twin.contextLength } : {}),
      })
      continue
    }
    if (healed === undefined) {
      rows.push({
        value: `openrouter/${model.id}`,
        label: model.name ?? model.id,
        description: '',
        descriptionForModel: `${model.name ?? model.id} (${model.id}) — listed by the connected ${source} but not dispatchable as spelled.`,
        group: OPENROUTER_MODEL_GROUP,
        unavailable: !rawVerdict.ok
          ? 'not a dispatchable id — the row carries display words, not a catalogue id'
          : 'not a dispatchable id — the row carries Mercury display dressing, not a catalogue id',
      })
      continue
    }
    if (emitted.has(model.id)) continue
    emitted.add(model.id)
    rows.push({
      value: `openrouter/${model.id}`,
      label: model.name ?? model.id,
      description: '',
      descriptionForModel: `${model.name ?? model.id} (${model.id}) — served through the connected ${source}, live-listed by the OpenRouter catalogue (most-popular order); persisted as openrouter/${model.id}.`,
      group: OPENROUTER_MODEL_GROUP,
      ...(wireReady ? {} : { unavailable: pendingReason }),
      ...(model.contextLength !== undefined ? { statedContextWindow: model.contextLength } : {}),
    })
  }
  return rows
}

/** Proof seam — clears catalogue cache + in-flight state. */
export function __resetOpenrouterCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
