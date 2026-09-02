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


const CATALOGUE_FETCH_TIMEOUT_MS = 15_000

export interface HuggingfaceLiveProvider {
  provider: string
  status: string
  contextLength?: number
  pricing?: { input?: number; output?: number }
  isFree?: boolean
  supportsTools?: boolean
  supportsStructuredOutput?: boolean
  firstTokenLatencyMs?: number
  throughput?: number
  isModelAuthor?: boolean
}

export interface HuggingfaceLiveModel {
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


export async function fetchHuggingfaceLiveModels(opts: {
  url: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<{ models: HuggingfaceLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions()
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


const CATALOGUE_TTL_MS = 5 * 60_000
const CATALOGUE_FAILURE_RETRY_MS = 10_000

export type HuggingfaceCatalogueKey = string

export interface HuggingfaceCatalogueSnapshot {
  key: HuggingfaceCatalogueKey
  models: HuggingfaceLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<HuggingfaceCatalogueKey, HuggingfaceCatalogueSnapshot>()
const catalogueInFlight = new Map<HuggingfaceCatalogueKey, Promise<HuggingfaceCatalogueSnapshot | null>>()

function storeSnapshot(key: HuggingfaceCatalogueKey, snapshot: HuggingfaceCatalogueSnapshot): void {
  catalogueCache.set(key, snapshot)
}

function catalogueKey(env: NodeJS.ProcessEnv): HuggingfaceCatalogueKey {
  const credential = resolveHuggingfaceApiKey(env)
  return credential ? `${credential.source}:${credentialFingerprint(credential.key)}` : 'anonymous'
}

export function getCachedHuggingfaceCatalogue(
  env: NodeJS.ProcessEnv = process.env,
): HuggingfaceCatalogueSnapshot | null {
  return catalogueCache.get(catalogueKey(env)) ?? catalogueCache.get('anonymous') ?? null
}

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
  if (!catalogueTrafficVerdict('huggingface', env).allowed) return Promise.resolve(cached ?? null)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window = cached && cached.models.length === 0 && cached.lastError ? CATALOGUE_FAILURE_RETRY_MS : CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(key)
  if (existing) return existing
  const work = (async (): Promise<HuggingfaceCatalogueSnapshot | null> => {
    try {
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

function reachableProviders(model: HuggingfaceLiveModel, suffix: string | undefined): HuggingfaceLiveProvider[] {
  const live = liveProviders(model)
  if (!suffix || HUGGINGFACE_POLICY_SUFFIXES.has(suffix.toLowerCase())) return live
  const named = live.filter(p => p.provider.toLowerCase() === suffix.toLowerCase())
  return named
}

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


export type HuggingfaceDisabledWhy = 'no-account' | 'auth-invalid' | 'catalogue-pending' | 'catalogue-error' | 'no-models'

export type HuggingfaceAvailability =
  | {
      state: 'disabled'
      why: HuggingfaceDisabledWhy
      reason: string
      liveIds: string[]
    }
  | {
      state: 'ready'
      ids: string[]
      modelCount: number
      source: string
      keySource: HuggingfaceKeySource
      fetchedAtMs: number
      catalogueNote?: string
    }

export function getHuggingfaceAvailability(env: NodeJS.ProcessEnv = process.env): HuggingfaceAvailability {
  const account = resolveHuggingfaceAccount(env)
  if (!account) {
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


export const HUGGINGFACE_MODEL_GROUP = 'Mercury — Hugging Face models'
export const HUGGINGFACE_CONNECT_OPTION_VALUE = '__mercury_huggingface_connect__'

const PICKER_ROW_BOUND = 24

export function getHuggingfaceModelOptions(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const availability = getHuggingfaceAvailability(env)
  const rows: ModelOption[] = []
  if (availability.state === 'disabled') {
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
    for (const model of models.slice(0, PICKER_ROW_BOUND)) {
      const verdict = canonicalWireModelId(`${HUGGINGFACE_MODEL_PREFIX}${model.id}`)
      const widest = liveProviders(model)
        .map(p => p.contextLength ?? 0)
        .reduce((a, b) => Math.max(a, b), 0)
      rows.push({
        value: `${HUGGINGFACE_MODEL_PREFIX}${model.id}`,
        label: huggingfaceSlugModelName(model.id),
        description: '',
        descriptionForModel: `${model.id} — served through the Hugging Face router (${availability.source}), live-listed in the router's own order; persisted as ${HUGGINGFACE_MODEL_PREFIX}${model.id}; append :<provider> or :cheapest/:preferred to steer the backend.`,
        group: HUGGINGFACE_MODEL_GROUP,
        ...(verdict.ok && verdict.healed !== true
          ? {}
          : { unavailable: 'not a dispatchable id — the row carries display words, not a catalogue id' }),
        ...(widest > 0 ? { statedContextWindow: widest } : {}),
      })
    }
    if (availability.modelCount > PICKER_ROW_BOUND) {
      rows.push({
        value: HUGGINGFACE_CONNECT_OPTION_VALUE,
        label: `Hugging Face — ${availability.modelCount} models live`,
        description: `top ${PICKER_ROW_BOUND} shown (the router's own order) · type huggingface/<org>/<model> for any other`,
        descriptionForModel: `The Hugging Face router lists ${availability.modelCount} live chat models; the picker renders the first ${PICKER_ROW_BOUND} in the router's order — any listed id dispatches when typed as huggingface/<org>/<model>.`,
        group: HUGGINGFACE_MODEL_GROUP,
        unavailable: 'a summary row — pick a listed model or type an id',
      })
    }
    return rows
  }
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

export function __resetHuggingfaceCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
