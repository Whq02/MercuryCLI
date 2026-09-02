// ============================================================================
//  providers/huggingface/huggingfaceCatalogue — the LIVE Hugging Face router
//  catalogue.
// ----------------------------------------------------------------------------
//  THE TRUTH DOCTRINE: the router serves the chat-completion lineup itself —
//  GET https://router.huggingface.co/v1/models (huggingface.co/docs/
//  inference-providers/hub-api, fetched 2026-08-22; probed live the same day:
//  the wire answers WITHOUT auth, 131 rows). The lineup is ONLY ever that
//  endpoint's answer, cached bounded + TTL'd + stale-but-labelled (the
//  openaiCatalogue discipline); the dated pins (huggingfacePins) are the
//  display fallback while a fetch is pending or failed, never the preference.
//
//  THE CATALOGUE DOOR (catalogueGate.ts): although the wire would answer
//  anonymously, Mercury never asks anonymously — the fetch happens only with
//  a live Hugging Face credential on this home, and
//  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC stops it outright. Signed out, the
//  picker says "connect Hugging Face to browse its models" — no request,
//  no bundled list wearing live clothes.
//
//  Wire (documented + observed): { object: 'list', data: [{ id ('<org>/
//  <model>'), object: 'model', created (unix s), owned_by, architecture
//  { input_modalities, output_modalities }, providers: [{ provider, status
//  ('live' | 'error'), context_length?, pricing? { input, output } (USD per
//  million tokens), is_free?, supports_tools?, supports_structured_output?,
//  first_token_latency_ms?, throughput?, is_model_author? }] }] }. Only
//  STATED fields are decoded — absent ≠ zero. The list arrives in the
//  router's own order (flagships first, observed) and the picker
//  keeps that order — never a Mercury ranking.
//
//  Per-model derived facts read by the capability edge and the dispatch:
//  the context window (the suffixed provider's stated length, else the
//  widest live provider's) and tool support (refused only when every live
//  provider that states the flag states false).
// ============================================================================
import type { ModelOption } from '../../../utils/model/modelOptions.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { getUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import { canonicalWireModelId } from '../routeLaw.js'
import {
  huggingfaceModelsUrl,
  resolveHuggingfaceAccount,
  resolveHuggingfaceApiKey,
  type HuggingfaceKeySource,
} from './huggingfaceAccounts.js'
import {
  HUGGINGFACE_DISPLAY_PINS,
  HUGGINGFACE_MODEL_PREFIX,
  HUGGINGFACE_POLICY_SUFFIXES,
  huggingfaceDisplayPin,
  huggingfaceSlugModelName,
  isHuggingfaceModelId,
  splitHuggingfaceSlug,
} from './huggingfacePins.js'

// ── The decoded live model (stated fields only) ─────────────────────────────

/** One deadline per catalogue request (the provider-call deadline law). */
const CATALOGUE_FETCH_TIMEOUT_MS = 15_000

export interface HuggingfaceLiveProvider {
  provider: string
  status: string
  contextLength?: number
  /** USD per million tokens, as stated. */
  pricing?: { input?: number; output?: number }
  isFree?: boolean
  supportsTools?: boolean
  supportsStructuredOutput?: boolean
  firstTokenLatencyMs?: number
  throughput?: number
  isModelAuthor?: boolean
}

export interface HuggingfaceLiveModel {
  /** The Hub slug, e.g. 'deepseek-ai/DeepSeek-V4-Pro-0813'. */
  id: string
  ownedBy?: string
  createdAtS?: number
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
  providers: HuggingfaceLiveProvider[]
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
}

function decodeProvider(raw: unknown): HuggingfaceLiveProvider | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const provider = str(r.provider)
  if (!provider) return undefined
  const pricing =
    typeof r.pricing === 'object' && r.pricing !== null ? (r.pricing as Record<string, unknown>) : undefined
  const decodedPricing = pricing
    ? {
        ...(num(pricing.input) !== undefined ? { input: num(pricing.input)! } : {}),
        ...(num(pricing.output) !== undefined ? { output: num(pricing.output)! } : {}),
      }
    : undefined
  return {
    provider,
    status: str(r.status) ?? 'unknown',
    ...(num(r.context_length) !== undefined ? { contextLength: num(r.context_length)! } : {}),
    ...(decodedPricing && Object.keys(decodedPricing).length > 0 ? { pricing: decodedPricing } : {}),
    ...(bool(r.is_free) !== undefined ? { isFree: bool(r.is_free)! } : {}),
    ...(bool(r.supports_tools) !== undefined ? { supportsTools: bool(r.supports_tools)! } : {}),
    ...(bool(r.supports_structured_output) !== undefined
      ? { supportsStructuredOutput: bool(r.supports_structured_output)! }
      : {}),
    ...(num(r.first_token_latency_ms) !== undefined ? { firstTokenLatencyMs: num(r.first_token_latency_ms)! } : {}),
    ...(num(r.throughput) !== undefined ? { throughput: num(r.throughput)! } : {}),
    ...(bool(r.is_model_author) !== undefined ? { isModelAuthor: bool(r.is_model_author)! } : {}),
  }
}

export function decodeHuggingfaceModel(raw: unknown): HuggingfaceLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return undefined
  const architecture =
    typeof r.architecture === 'object' && r.architecture !== null
      ? (r.architecture as Record<string, unknown>)
      : undefined
  const providers = Array.isArray(r.providers)
    ? r.providers.map(decodeProvider).filter((p): p is HuggingfaceLiveProvider => p !== undefined)
    : []
  return {
    id,
    ...(str(r.owned_by) !== undefined ? { ownedBy: str(r.owned_by)! } : {}),
    ...(num(r.created) !== undefined ? { createdAtS: num(r.created)! } : {}),
    ...(strArray(architecture?.input_modalities) !== undefined
      ? { inputModalities: strArray(architecture?.input_modalities)! }
      : {}),
    ...(strArray(architecture?.output_modalities) !== undefined
      ? { outputModalities: strArray(architecture?.output_modalities)! }
      : {}),
    providers,
  }
}

// ── The live fetch ──────────────────────────────────────────────────────────

export async function fetchHuggingfaceLiveModels(opts: {
  url: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<{ models: HuggingfaceLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions()
  // The provider-call deadline law: the models request ends within the bound.
  const response = await fetchWithProviderDeadline(fetchImpl, 'huggingface', CATALOGUE_FETCH_TIMEOUT_MS, opts.url, {
    method: 'GET',
    headers: { ...(opts.headers ?? {}), accept: 'application/json', 'user-agent': getUserAgent() },
    ...(proxyOptions as Record<string, unknown>),
  } as RequestInit)
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? `huggingface models endpoint refused the credential (HTTP ${response.status})`
        : `huggingface models endpoint returned HTTP ${response.status}`,
    )
  }
  const parsed = (await response.json()) as Record<string, unknown>
  const data = Array.isArray(parsed.data) ? parsed.data : []
  const models: HuggingfaceLiveModel[] = []
  for (const raw of data) {
    const model = decodeHuggingfaceModel(raw)
    if (model) models.push(model)
  }
  return { models, fetchedAtMs: Date.now() }
}

// ── The bounded snapshot cache (per key source; TTL'd; single-flight) ───────

const CATALOGUE_TTL_MS = 5 * 60_000
const CATALOGUE_FAILURE_RETRY_MS = 10_000

/** The list is public; a keyed view may differ, so snapshots key on the
 *  credential source (an uncredentialed fetch is 'anonymous'). */
/** 'anonymous' for the public list; else `<source>:<credential digest>` —
 *  a keyed view is a fact about ONE token, so a relogin under another token
 *  never reuses the departed token's snapshot for the rest of the TTL. */
export type HuggingfaceCatalogueKey = string

export interface HuggingfaceCatalogueSnapshot {
  key: HuggingfaceCatalogueKey
  models: HuggingfaceLiveModel[]
  /** When the MODELS were actually fetched (0 = never) — the staleness label. */
  fetchedAtMs: number
  lastAttemptAtMs?: number
  /** Set when the last refresh failed — the stale-but-labelled channel. */
  lastError?: string
}

const catalogueCache = new Map<HuggingfaceCatalogueKey, HuggingfaceCatalogueSnapshot>()
const catalogueInFlight = new Map<HuggingfaceCatalogueKey, Promise<HuggingfaceCatalogueSnapshot | null>>()

/** Every snapshot write is a context-window-source change: the stated
 *  provider context_length rows decide a huggingface id's budget
 *  (capabilities.ts). */
function storeSnapshot(key: HuggingfaceCatalogueKey, snapshot: HuggingfaceCatalogueSnapshot): void {
  catalogueCache.set(key, snapshot)
}

function catalogueKey(env: NodeJS.ProcessEnv): HuggingfaceCatalogueKey {
  const credential = resolveHuggingfaceApiKey(env)
  return credential ? `${credential.source}:${credentialFingerprint(credential.key)}` : 'anonymous'
}

/** Sync cache read — the CURRENT credential source's snapshot, else the
 *  anonymous one (the public list serves every view until a keyed fetch
 *  lands); null when nothing was ever fetched. */
export function getCachedHuggingfaceCatalogue(
  env: NodeJS.ProcessEnv = process.env,
): HuggingfaceCatalogueSnapshot | null {
  return catalogueCache.get(catalogueKey(env)) ?? catalogueCache.get('anonymous') ?? null
}

/** Async refresh honoring the TTL (force bypasses). Single-flight per key
 *  source. Failures label the cache, never throw. */
export function refreshHuggingfaceCatalogue(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<HuggingfaceCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const key = catalogueKey(env)
  const cached = catalogueCache.get(key)
  // THE DOOR (catalogueGate): no credential, or catalogue traffic switched
  // off, means NO request — the refusal is a non-event (no snapshot write,
  // no epoch bump); whatever is cached keeps serving, labelled as it stands.
  if (!catalogueTrafficVerdict('huggingface', env).allowed) return Promise.resolve(cached ?? null)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window = cached && cached.models.length === 0 && cached.lastError ? CATALOGUE_FAILURE_RETRY_MS : CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(key)
  if (existing) return existing
  const work = (async (): Promise<HuggingfaceCatalogueSnapshot | null> => {
    try {
      // The door held, so the credential exists — the fetch ALWAYS carries
      // it; the anonymous request retired with the catalogue-gating law.
      const credential = resolveHuggingfaceApiKey(env)
      const result = await fetchHuggingfaceLiveModels({
        url: huggingfaceModelsUrl(env),
        ...(credential ? { headers: { authorization: `Bearer ${credential.key}` } } : {}),
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: HuggingfaceCatalogueSnapshot = { key, models: result.models, fetchedAtMs: result.fetchedAtMs }
      storeSnapshot(key, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: HuggingfaceCatalogueSnapshot = {
        key,
        models: cached?.models ?? [],
        fetchedAtMs: cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
      storeSnapshot(key, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(key)
      bumpCatalogueEpoch()
    }
  })()
  catalogueInFlight.set(key, work)
  return work
}

// ── Per-model derived facts (the capability edge + the dispatch read these) ─

/** The live record for a wire slug (suffix ignored for the lookup). */
export function huggingfaceLiveModel(
  wireSlug: string,
  env: NodeJS.ProcessEnv = process.env,
): HuggingfaceLiveModel | undefined {
  const snapshot = getCachedHuggingfaceCatalogue(env)
  if (!snapshot) return undefined
  const { hubId } = splitHuggingfaceSlug(wireSlug)
  const lower = hubId.toLowerCase()
  return snapshot.models.find(m => m.id.toLowerCase() === lower)
}

function liveProviders(model: HuggingfaceLiveModel): HuggingfaceLiveProvider[] {
  return model.providers.filter(p => p.status === 'live')
}

/** The providers a suffixed slug can reach: the named provider only, or
 *  every live provider for a bare/policy-suffixed slug. */
function reachableProviders(model: HuggingfaceLiveModel, suffix: string | undefined): HuggingfaceLiveProvider[] {
  const live = liveProviders(model)
  if (!suffix || HUGGINGFACE_POLICY_SUFFIXES.has(suffix.toLowerCase())) return live
  const named = live.filter(p => p.provider.toLowerCase() === suffix.toLowerCase())
  return named
}

/** The context window the live catalogue states for a wire slug: the named
 *  provider's context_length, else the widest live provider's; undefined
 *  when nothing is stated (the caller falls to the dated pin, then the
 *  conservative default — absent beats invented). */
export function huggingfaceLiveContextWindow(
  wireSlug: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const model = huggingfaceLiveModel(wireSlug, env)
  if (!model) return undefined
  const { suffix } = splitHuggingfaceSlug(wireSlug)
  const lengths = reachableProviders(model, suffix)
    .map(p => p.contextLength)
    .filter((n): n is number => typeof n === 'number' && n > 0)
  return lengths.length > 0 ? Math.max(...lengths) : undefined
}

/** Tool support for a wire slug: false only when every reachable provider
 *  that STATES the flag states false (the honest refusal); true when one
 *  states true; undefined when nothing is stated or the model is unlisted. */
export function huggingfaceLiveSupportsTools(
  wireSlug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const model = huggingfaceLiveModel(wireSlug, env)
  if (!model) return undefined
  const { suffix } = splitHuggingfaceSlug(wireSlug)
  const stated = reachableProviders(model, suffix)
    .map(p => p.supportsTools)
    .filter((b): b is boolean => typeof b === 'boolean')
  if (stated.length === 0) return undefined
  return stated.some(Boolean)
}

/** The context window for a PERSISTED id (namespaced): live first, then the
 *  dated pin; undefined otherwise. The source word lets readers label it. */
export function huggingfaceContextWindowFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { window: number; source: 'live-current' | 'static-pin' } | undefined {
  if (!isHuggingfaceModelId(model)) return undefined
  const slug = model.trim().slice(HUGGINGFACE_MODEL_PREFIX.length)
  const live = huggingfaceLiveContextWindow(slug, env)
  if (live !== undefined) return { window: live, source: 'live-current' }
  const pin = huggingfaceDisplayPin(slug)
  return pin?.contextWindow !== undefined ? { window: pin.contextWindow, source: 'static-pin' } : undefined
}

// ── Availability (the honest chain the picker + surfaces derive from) ───────

export type HuggingfaceDisabledWhy = 'no-account' | 'auth-invalid' | 'catalogue-pending' | 'catalogue-error' | 'no-models'

export type HuggingfaceAvailability =
  | {
      state: 'disabled'
      why: HuggingfaceDisabledWhy
      reason: string
      /** Always empty while signed out — the catalogue-gating law: no
       *  credential means no request, and no bundled/stale lineup is
       *  advertised in its place (the honest face is the connect row). */
      liveIds: string[]
    }
  | {
      state: 'ready'
      /** Live ids in the router's own order; empty while the catalogue is
       *  pending or failed (the pins render then, selectable — the router
       *  answers at dispatch). */
      ids: string[]
      modelCount: number
      /** Account-source label (billing honesty). */
      source: string
      keySource: HuggingfaceKeySource
      /** The snapshot's fetch stamp (0 = the pins are standing in). */
      fetchedAtMs: number
      catalogueNote?: string
    }

export function getHuggingfaceAvailability(env: NodeJS.ProcessEnv = process.env): HuggingfaceAvailability {
  const account = resolveHuggingfaceAccount(env)
  if (!account) {
    // Signed out ⇒ the door refuses the fetch before it exists; the honest
    // face carries the ruled sentence and advertises no lineup at all.
    return {
      state: 'disabled',
      why: 'no-account',
      reason: `${connectToBrowseReason('huggingface')} — /logins connects (or HF_TOKEN)`,
      liveIds: [],
    }
  }
  const snapshot = getCachedHuggingfaceCatalogue(env)
  const verdict = catalogueTrafficVerdict('huggingface', env)
  if (!verdict.allowed) {
    // Credentialed but dark (MERCURY_DISABLE_NONESSENTIAL_TRAFFIC): dispatch
    // stays live, so the lane stays ready — the note names the switch, any
    // cached rows keep their fetch stamp, and nothing is requested.
    return {
      state: 'ready',
      ids: snapshot?.models.map(m => m.id) ?? [],
      modelCount: snapshot?.models.length ?? 0,
      source: account.label,
      keySource: account.keySource,
      fetchedAtMs: snapshot?.fetchedAtMs ?? 0,
      catalogueNote: verdict.reason,
    }
  }
  if (!snapshot) void refreshHuggingfaceCatalogue({ env }).catch(() => {})
  const liveIds = snapshot?.models.map(m => m.id) ?? []
  if (snapshot && snapshot.models.length === 0 && snapshot.lastError && /refused the credential/.test(snapshot.lastError)) {
    void refreshHuggingfaceCatalogue({ env }).catch(() => {})
    return {
      state: 'disabled',
      why: 'auth-invalid',
      reason: 'the Hugging Face credential was refused — /logins re-connects',
      liveIds: [],
    }
  }
  const catalogueNote =
    !snapshot
      ? 'live catalogue not fetched yet — the dated pins stand in'
      : snapshot.models.length === 0
        ? `live catalogue unavailable${snapshot.lastError ? ` (${snapshot.lastError})` : ''} — the dated pins stand in`
        : snapshot.lastError
          ? `last refresh failed (${snapshot.lastError}) — showing the list fetched earlier`
          : undefined
  return {
    state: 'ready',
    ids: liveIds,
    modelCount: liveIds.length,
    source: account.label,
    keySource: account.keySource,
    fetchedAtMs: snapshot?.fetchedAtMs ?? 0,
    ...(catalogueNote ? { catalogueNote } : {}),
  }
}

// ── The /model picker rows ──────────────────────────────────────────────────

/** The picker group heading (the OPENAI_MODEL_GROUP grammar). */
export const HUGGINGFACE_MODEL_GROUP = 'Mercury — Hugging Face models'
/** The connect action sentinel (a picker ACTION, never a model). */
export const HUGGINGFACE_CONNECT_OPTION_VALUE = '__mercury_huggingface_connect__'
/** The catalogue DOOR sentinel (a picker ACTION, never a model): the row
 *  past the bound whose ↵ expands the group to the full live list behind a
 *  type-to-filter line (isCatalogueDoorRow shape-matches it). */
export const HUGGINGFACE_EXPAND_OPTION_VALUE = '__mercury_huggingface_expand__'

/** How many live rows the picker renders before the door (the router's own
 *  order); the door expands to every row the snapshot holds
 *  (getHuggingfaceFullModelOptions), the snapshot accessors serve every
 *  other surface, and an exact huggingface/<org>/<model> id always types. */
const PICKER_ROW_BOUND = 24

/** The ONE picker-row builder over the snapshot's models: the first `bound`
 *  rows in the router's order, each adjudicated by the wire-id owner. The
 *  bounded picker view and the door's full list both derive here, so a row
 *  reads the same at both depths. */
function huggingfaceCatalogueRows(models: HuggingfaceLiveModel[], source: string, bound: number): ModelOption[] {
  const rows: ModelOption[] = []
  for (const model of models.slice(0, bound)) {
    // Row truth (the openrouter picker's law, same class): an id the
    // wire-id owner would refuse — display words or a composed prefix in
    // the catalogue data itself — renders visible-but-unavailable; junk
    // never persists as a selection.
    const verdict = canonicalWireModelId(`${HUGGINGFACE_MODEL_PREFIX}${model.id}`)
    const widest = liveProviders(model)
      .map(p => p.contextLength ?? 0)
      .reduce((a, b) => Math.max(a, b), 0)
    rows.push({
      value: `${HUGGINGFACE_MODEL_PREFIX}${model.id}`,
      label: huggingfaceSlugModelName(model.id),
      description: '',
      descriptionForModel: `${model.id} — served through the Hugging Face router (${source}), live-listed in the router's own order; persisted as ${HUGGINGFACE_MODEL_PREFIX}${model.id}; append :<provider> or :cheapest/:preferred to steer the backend.`,
      group: HUGGINGFACE_MODEL_GROUP,
      ...(verdict.ok && verdict.healed !== true
        ? {}
        : { unavailable: 'not a dispatchable id — the row carries display words, not a catalogue id' }),
      ...(widest > 0 ? { statedContextWindow: widest } : {}),
    })
  }
  return rows
}

/** EVERY snapshot row as picker rows — the door's expanded list: the same
 *  builder as the bounded view (adjudicated the same way, the router's
 *  order), unbounded. Empty unless the lane is ready with live rows. */
export function getHuggingfaceFullModelOptions(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const availability = getHuggingfaceAvailability(env)
  if (availability.state !== 'ready') return []
  const models = getCachedHuggingfaceCatalogue(env)?.models ?? []
  return huggingfaceCatalogueRows(models, availability.source, models.length)
}

/** The /model picker rows for the Hugging Face lane. Model rows carry NO
 *  description (the neutrality ruling: one empty grammar for every
 *  provider's model rows) — the window fact rides statedContextWindow and
 *  the account/source state rides the group heading detail. */
export function getHuggingfaceModelOptions(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const availability = getHuggingfaceAvailability(env)
  const rows: ModelOption[] = []
  if (availability.state === 'disabled') {
    // The signed-out face is ONE honest row (the catalogue-gating law): with
    // no credential there is no catalogue request, and no list — bundled
    // pins or a leftover snapshot — renders where a browsable catalogue
    // would sit. The row says the ruled sentence and routes to /logins.
    return [
      {
        value: HUGGINGFACE_CONNECT_OPTION_VALUE,
        label: 'Hugging Face — sign in',
        description: `${connectToBrowseReason('huggingface')} — ↵ runs /logins (HF_TOKEN works too)`,
        descriptionForModel:
          'The Hugging Face group is not connected — no catalogue is fetched while signed out; the operator signs in with /logins (device-code OAuth or a pasted token) and the rows then derive live from the router catalogue.',
        group: HUGGINGFACE_MODEL_GROUP,
      },
    ]
  }
  const snapshot = getCachedHuggingfaceCatalogue(env)
  const models = snapshot?.models ?? []
  if (models.length > 0) {
    rows.push(...huggingfaceCatalogueRows(models, availability.source, PICKER_ROW_BOUND))
    if (availability.modelCount > PICKER_ROW_BOUND) {
      // THE DOOR: the rows past the bound are one ↵ away — the picker
      // expands the group in place to the full live list (the same builder,
      // unbounded) behind a filter line; the copy says exactly that, in the
      // grammar every catalogue door shares. The count is the
      // availability's, and the row is an ACTION (never a model, never
      // counted as one).
      rows.push({
        value: HUGGINGFACE_EXPAND_OPTION_VALUE,
        label: `Hugging Face — ${availability.modelCount} models live`,
        description: `↵ expand · ${availability.modelCount} live · type to filter`,
        descriptionForModel: `The Hugging Face router lists ${availability.modelCount} live chat models; the picker renders the first ${PICKER_ROW_BOUND} in the router's order, and this row expands the group to the full list behind a filter — any listed id also dispatches when typed as huggingface/<org>/<model>.`,
        group: HUGGINGFACE_MODEL_GROUP,
        catalogueDoor: { family: 'Hugging Face', total: availability.modelCount },
      })
    }
    return rows
  }
  // Catalogue pending/failed/dark: the dated pins stand in, SELECTABLE — the
  // router answers at dispatch. Pending/failed states retry on ↵; with
  // catalogue traffic switched off the row names the switch instead of
  // offering a retry that would be refused at the door.
  const verdict = catalogueTrafficVerdict('huggingface', env)
  const trafficOff = !verdict.allowed && verdict.why === 'traffic-off'
  rows.push({
    value: HUGGINGFACE_CONNECT_OPTION_VALUE,
    label: trafficOff ? 'Hugging Face — catalogue off' : 'Hugging Face — catalogue pending',
    description: trafficOff
      ? (availability.catalogueNote ?? verdict.reason)
      : `${availability.catalogueNote ?? 'live catalogue pending'} — ↵ retries now`,
    descriptionForModel: trafficOff
      ? `Catalogue traffic is switched off (${availability.catalogueNote ?? verdict.reason}); the dated pins below dispatch directly and no model-list request is made.`
      : `The Hugging Face live catalogue is not available (${availability.catalogueNote ?? 'pending'}); the dated pins below dispatch directly and the router answers for itself.`,
    group: HUGGINGFACE_MODEL_GROUP,
  })
  for (const pin of HUGGINGFACE_DISPLAY_PINS) {
    rows.push({
      value: `${HUGGINGFACE_MODEL_PREFIX}${pin.id}`,
      label: pin.displayName,
      description: '',
      descriptionForModel: `${pin.displayName} (${pin.id}) — Hugging Face router model as observed ${pin.observedAt} (the live catalogue is unavailable right now); dispatches through ${availability.source}.`,
      group: HUGGINGFACE_MODEL_GROUP,
      statedContextWindow: pin.contextWindow,
    })
  }
  return rows
}

/** Proof seam — clears catalogue cache + in-flight state. */
export function __resetHuggingfaceCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
