import { primeOpenaiDiscovery } from '../../../utils/router/providerDiscovery.js'
import {
  openaiSourceIdentity,
  openaiSubscriptionPresence,
  resolveOpenaiAccount,
  resolveOpenaiRequestAuth,
  type OpenaiAccountSourceKind,
} from './openaiAccounts.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict, connectToBrowseReason } from '../catalogueGate.js'
import { fetchOpenaiLiveModels, type OpenaiLiveModel } from './openaiClient.js'


export const APEX_ARCHITECTURE_EPOCH = 'apex-1'
export const OPENAI_ADAPTER_DIGEST = 'openai-responses-adapter@1:sse-fold@1:stateless-replay'

import {
  gptDisplayPin,
  nearestSupportedWireEffort,
  parseGptModelId,
  stripGptServedWindowSuffix,
  type GptDisplayPin,
  type GptModelIdentity,
} from './gptPins.js'

export {
  GPT_DISPLAY_PINS,
  GPT_SERVED_WINDOW_SUFFIX,
  WIRE_EFFORT_RANK,
  gptDisplayName,
  gptDisplayPin,
  hasGptServedWindowSuffix,
  nearestSupportedWireEffort,
  parseGptModelId,
  stripGptServedWindowSuffix,
  withGptServedWindowSuffix,
} from './gptPins.js'
export type { GptDisplayPin, GptModelIdentity } from './gptPins.js'


const OPENAI_CATALOGUE_TTL_MS = 5 * 60_000
const OPENAI_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface OpenaiCatalogueSnapshot {
  sourceKind: OpenaiAccountSourceKind
  models: OpenaiLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const catalogueCache = new Map<string, OpenaiCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<OpenaiCatalogueSnapshot | null>>()
function storeSnapshot(identity: string, snapshot: OpenaiCatalogueSnapshot): void {
  catalogueCache.set(identity, snapshot)
}


function catalogueIdentity(sourceKind: OpenaiAccountSourceKind, env?: NodeJS.ProcessEnv): string {
  return `${sourceKind}:${openaiSourceIdentity(sourceKind, env)}`
}

export function getCachedOpenaiCatalogue(
  sourceKind: OpenaiAccountSourceKind,
  env: NodeJS.ProcessEnv = process.env,
): OpenaiCatalogueSnapshot | null {
  return catalogueCache.get(catalogueIdentity(sourceKind, env)) ?? null
}

export function refreshOpenaiCatalogue(
  sourceKind: OpenaiAccountSourceKind,
  opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<OpenaiCatalogueSnapshot | null> {
  const now = opts?.now ?? Date.now
  const identity = catalogueIdentity(sourceKind, opts?.env)
  const cached = catalogueCache.get(identity)
  if (!catalogueTrafficVerdict('openai', opts?.env ?? process.env).allowed) {
    return Promise.resolve(cached ?? null)
  }
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window =
    cached && cached.models.length === 0 && cached.lastError
      ? OPENAI_CATALOGUE_FAILURE_RETRY_MS
      : OPENAI_CATALOGUE_TTL_MS
  if (!opts?.force && cached && now() - anchor < window) {
    return Promise.resolve(cached)
  }
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<OpenaiCatalogueSnapshot | null> => {
    try {
      const auth = await resolveOpenaiRequestAuth({
        sourceKind,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts?.env ? { env: opts.env } : {}),
      })
      if (!auth) {
        const snapshot: OpenaiCatalogueSnapshot = {
          sourceKind,
          models: cached?.models ?? [],
          fetchedAtMs: cached?.fetchedAtMs ?? 0,
          lastAttemptAtMs: now(),
          lastError: 'account-source-unavailable',
        }
        storeSnapshot(identity, snapshot)
        return snapshot
      }
      const result = await fetchOpenaiLiveModels({
        baseUrl: auth.baseUrl,
        headers: auth.headers,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: OpenaiCatalogueSnapshot = {
        sourceKind,
        models: result.models,
        fetchedAtMs: result.fetchedAtMs,
      }
      storeSnapshot(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: OpenaiCatalogueSnapshot = {
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

export function primeOpenaiCatalogue(
  snapshot: { sourceKind: OpenaiAccountSourceKind; models: OpenaiLiveModel[]; fetchedAtMs: number },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!Array.isArray(snapshot.models) || snapshot.models.length === 0 || !(snapshot.fetchedAtMs > 0)) return false
  const identity = catalogueIdentity(snapshot.sourceKind, env)
  const cached = catalogueCache.get(identity)
  if (cached && cached.fetchedAtMs >= snapshot.fetchedAtMs) return false
  storeSnapshot(identity, {
    sourceKind: snapshot.sourceKind,
    models: snapshot.models,
    fetchedAtMs: snapshot.fetchedAtMs,
    lastAttemptAtMs: snapshot.fetchedAtMs,
  })
  bumpCatalogueEpoch()
  return true
}


export const APEX_GPT_ROLES = [
  'primary',
  'specialist',
  'coordinator',
] as const
export type ApexGptRole = (typeof APEX_GPT_ROLES)[number]

export interface GptQualificationReceipt {
  modelId: string
  role: ApexGptRole
  sourceKind: OpenaiAccountSourceKind
  adapterDigest: string
  architectureEpoch: string
  liveEfforts: string[]
  defaultEffort?: string
  qualifiedAtMs: number
}

export interface GptCandidate {
  identity: GptModelIdentity
  live: OpenaiLiveModel
  displayName: string
  pin?: GptDisplayPin
}

export type GptDisqualification =
  | { reason: 'account-source-unavailable' }
  | { reason: 'catalogue-unavailable'; detail?: string }
  | { reason: 'not-in-live-catalogue' }
  | { reason: 'hidden-or-retired'; detail: string }
  | { reason: 'not-gpt-family' }
  | { reason: 'unparseable-id' }
  | { reason: 'effort-catalogue-undecodable' }

export function evaluateGptCandidate(
  modelId: string,
  sourceKind: OpenaiAccountSourceKind,
): { ok: true; candidate: GptCandidate } | { ok: false; why: GptDisqualification } {
  const identity = parseGptModelId(modelId)
  if (!identity) {
    return modelId.trim().toLowerCase().startsWith('gpt')
      ? { ok: false, why: { reason: 'unparseable-id' } }
      : { ok: false, why: { reason: 'not-gpt-family' } }
  }
  const snapshot = getCachedOpenaiCatalogue(sourceKind)
  if (!snapshot || (snapshot.models.length === 0 && snapshot.lastError)) {
    return {
      ok: false,
      why: {
        reason: 'catalogue-unavailable',
        ...(snapshot?.lastError ? { detail: snapshot.lastError } : {}),
      },
    }
  }
  const live = snapshot.models.find(m => m.id.toLowerCase() === identity.canonicalId)
  if (!live) return { ok: false, why: { reason: 'not-in-live-catalogue' } }
  const VISIBLE = new Set(['list', 'visible', 'public'])
  if (live.visibility && !VISIBLE.has(live.visibility)) {
    return { ok: false, why: { reason: 'hidden-or-retired', detail: live.visibility } }
  }
  if (!Array.isArray(live.supportedReasoningEfforts)) {
    return { ok: false, why: { reason: 'effort-catalogue-undecodable' } }
  }
  const pin = gptDisplayPin(identity.canonicalId)
  return {
    ok: true,
    candidate: {
      identity,
      live,
      displayName: live.displayName ?? pin?.displayName ?? identity.canonicalId,
      ...(pin ? { pin } : {}),
    },
  }
}

export function qualifiedGptCandidates(
  role: ApexGptRole,
  sourceKind: OpenaiAccountSourceKind,
): GptCandidate[] {
  const snapshot = getCachedOpenaiCatalogue(sourceKind)
  if (!snapshot) return []
  const out: GptCandidate[] = []
  for (const model of snapshot.models) {
    const evaluated = evaluateGptCandidate(model.id, sourceKind)
    if (evaluated.ok) out.push(evaluated.candidate)
  }
  out.sort(
    (a, b) =>
      (a.live.priority ?? Number.POSITIVE_INFINITY) -
      (b.live.priority ?? Number.POSITIVE_INFINITY),
  )
  void role
  return out
}

export type GptSeatDisabledWhy =
  | 'no-account'
  | 'auth-expired'
  | 'catalogue-pending'
  | 'catalogue-error'
  | 'no-qualified-ids'
  | 'traffic-off'

export type GptSeatAvailability =
  | { state: 'disabled'; why: GptSeatDisabledWhy; reason: string }
  | {
      state: 'ready'
      ids: string[]
      source: string
      sourceKind: OpenaiAccountSourceKind
    }

export function getGptSeatAvailability(): GptSeatAvailability {
  const account = resolveOpenaiAccount()
  if (!account) {
    const presence = openaiSubscriptionPresence()
    if (presence.state === 'expired') {
      return {
        state: 'disabled',
        why: 'auth-expired',
        reason: 'OpenAI sign-in expired — /logins openai signs in again',
      }
    }
    return {
      state: 'disabled',
      why: 'no-account',
      reason: `${connectToBrowseReason('openai')} — /logins connects`,
    }
  }
  const snapshot = getCachedOpenaiCatalogue(account.kind)
  const verdict = catalogueTrafficVerdict('openai')
  if (!verdict.allowed && (!snapshot || snapshot.models.length === 0)) {
    return { state: 'disabled', why: 'traffic-off', reason: verdict.reason }
  }
  if (!snapshot) {
    void refreshOpenaiCatalogue(account.kind).catch(() => {})
    return {
      state: 'disabled',
      why: 'catalogue-pending',
      reason: 'live catalogue not fetched yet — retry shortly',
    }
  }
  if (snapshot.models.length === 0 && snapshot.lastError) {
    void refreshOpenaiCatalogue(account.kind).catch(() => {})
    if (snapshot.lastError === 'account-source-unavailable') {
      return {
        state: 'disabled',
        why: 'auth-expired',
        reason: 'OpenAI sign-in expired or unavailable — /logins re-connects',
      }
    }
    return {
      state: 'disabled',
      why: 'catalogue-error',
      reason: `live catalogue unreachable (${snapshot.lastError})`,
    }
  }
  const ids = qualifiedGptCandidates('primary', account.kind).map(c => c.identity.canonicalId)
  if (ids.length === 0) {
    return {
      state: 'disabled',
      why: 'no-qualified-ids',
      reason: 'the live catalogue offers no usable GPT ids',
    }
  }
  return { state: 'ready', ids, source: account.label, sourceKind: account.kind }
}


export interface GptReasoningProfile {
  wireEffort?: string
  source: 'user' | 'model-default' | 'unsupported-fallback'
  adjustedFrom?: string
}

export function resolveGptReasoningProfile(
  requested: string | undefined,
  live: OpenaiLiveModel,
): GptReasoningProfile {
  const supported = live.supportedReasoningEfforts
  if (supported.length === 0) {
    return {
      source: requested ? 'unsupported-fallback' : 'model-default',
      ...(requested ? { adjustedFrom: requested } : {}),
    }
  }
  if (requested && supported.includes(requested)) {
    return { wireEffort: requested, source: 'user' }
  }
  if (requested) {
    const nearest = nearestSupportedWireEffort(requested, supported)
    const fallback =
      nearest ??
      live.defaultReasoningEffort ??
      (supported.includes('high') ? 'high' : supported[0])
    return {
      ...(fallback ? { wireEffort: fallback } : {}),
      source: 'unsupported-fallback',
      adjustedFrom: requested,
    }
  }
  const fallback = live.defaultReasoningEffort ?? (supported.includes('high') ? 'high' : supported[0])
  return { ...(fallback ? { wireEffort: fallback } : {}), source: 'model-default' }
}

export function liveGptContextWindow(modelId: string): number | undefined {
  return liveGptModel(modelId)?.contextWindow
}

export function liveGptContextCeiling(modelId: string): number | undefined {
  const model = liveGptModel(modelId)
  if (!model) return undefined
  const { contextWindow, maxContextWindow } = model
  if (maxContextWindow === undefined) return undefined
  if (contextWindow !== undefined && maxContextWindow <= contextWindow) return undefined
  return maxContextWindow
}

function liveGptModel(modelId: string): OpenaiLiveModel | undefined {
  const identity = parseGptModelId(modelId)
  if (!identity) return undefined
  const discovery = primeOpenaiDiscovery()
  const account = discovery?.provider === 'openai' ? discovery.account : undefined
  if (!account) return undefined
  const snapshot = getCachedOpenaiCatalogue(account.kind)
  return snapshot?.models.find(m => m.id.toLowerCase() === identity.canonicalId)
}

export function liveGptEffortCatalogue(modelId: string):
  | { vocabulary: readonly string[]; stated: boolean; defaultEffort?: string }
  | undefined {
  const model = liveGptModel(modelId)
  if (!model) return undefined
  return {
    vocabulary: [...model.supportedReasoningEfforts],
    stated: model.reasoningEffortsStated,
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  }
}

export function liveGptDefaultEffort(modelId: string): string | undefined {
  return liveGptModel(modelId)?.defaultReasoningEffort
}

export function __resetOpenaiCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
