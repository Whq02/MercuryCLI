// ============================================================================
//  providers/openai/openaiCatalogue — the live GPT catalogue + the ONE typed
//  model-qualification owner.
//
//  Laws:
// a model is SELECTABLE in an GPT role only when (1) LIVE-discovered
//      from the active account source, (2) not hidden/retired, (3) a parseable
//      GPT-family id (the pure grammar — a regex vibe alone is never enough),
//      (4) its live effort catalogue decodes, and (5) the role's capability
//      receipt is current. The account source's served catalogue IS the
//      selectable set — the era generation floor (≥5.6) was removed
//      (it contradicted the provider-parity direction: every model
//      the account serves is pickable);
//    - STATIC PINS NEVER ACTIVATE — the display table below serves fixtures,
//      docs and unavailable-row copy only;
//    - the cache is bounded, TTL'd, single-flight,
//      stale-but-labelled (fetchedAtMs rides every read);
//    - qualification receipts tie {model id, role id, adapter digest,
//      behaviour-contract digest, architecture epoch} — a digest mismatch is
//      an expired receipt, never a silent pass.
// ============================================================================
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

// ── Architecture identity (rides every receipt) ─────────────────────────────

export const APEX_ARCHITECTURE_EPOCH = 'apex-1'
/** Bumped when the request/stream adapter's wire behaviour changes. */
export const OPENAI_ADAPTER_DIGEST = 'openai-responses-adapter@1:sse-fold@1:stateless-replay'

// ── Family grammar + display pins: the PURE module (gptPins.ts) owns them so
//    the selector estate (display/context/cost/seat validation) can consume
//    them without this module's account/gate dependency graph; re-exported
//    here so provider-side consumers keep ONE import surface. ────────────────
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

// ── The bounded live catalogue cache (per account source) ───────────────────

const OPENAI_CATALOGUE_TTL_MS = 5 * 60_000
/** A FAILED snapshot (no models + lastError) retries on this much shorter
 *  cadence — a transient boot-race fetch failure must not pin the lane
 *  "unreachable" for the whole success TTL (the success cache stays 5m). */
const OPENAI_CATALOGUE_FAILURE_RETRY_MS = 10_000

export interface OpenaiCatalogueSnapshot {
  sourceKind: OpenaiAccountSourceKind
  models: OpenaiLiveModel[]
  /** When the MODELS were actually fetched (0 = never) — the staleness label. */
  fetchedAtMs: number
  /** When the last refresh ATTEMPT ran (success or failure) — the TTL anchor,
   *  so a failing endpoint is retried at TTL cadence, never hammered per call
   *  (and a fixture-seeded failure snapshot stays authoritative in proofs). */
  lastAttemptAtMs?: number
  /** Set when the last refresh failed — the stale-but-labelled channel. */
  lastError?: string
}

const catalogueCache = new Map<string, OpenaiCatalogueSnapshot>()
const catalogueInFlight = new Map<string, Promise<OpenaiCatalogueSnapshot | null>>()
/** Every snapshot write is a context-window-source change: the rows
 *  decide a persisted id's budget (capabilities.ts). */
function storeSnapshot(identity: string, snapshot: OpenaiCatalogueSnapshot): void {
  catalogueCache.set(identity, snapshot)
}


/** The snapshot identity: source kind + the CURRENT credential's digest. A
 *  catalogue (and the qualification derived from it) is a fact about one
 *  account — a relogin under another key or ChatGPT account is a NEW
 *  catalogue, never the departed account's rows for the rest of the TTL. */
function catalogueIdentity(sourceKind: OpenaiAccountSourceKind, env?: NodeJS.ProcessEnv): string {
  return `${sourceKind}:${openaiSourceIdentity(sourceKind, env)}`
}

/** Sync cache read — free; null when never fetched (or fetched by a
 *  credential that is no longer the source's current one). */
export function getCachedOpenaiCatalogue(
  sourceKind: OpenaiAccountSourceKind,
  env: NodeJS.ProcessEnv = process.env,
): OpenaiCatalogueSnapshot | null {
  return catalogueCache.get(catalogueIdentity(sourceKind, env)) ?? null
}

/** Async refresh honoring the TTL (force bypasses). Single-flight per
 *  source credential. Failures label the cache, never throw. */
export function refreshOpenaiCatalogue(
  sourceKind: OpenaiAccountSourceKind,
  opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<OpenaiCatalogueSnapshot | null> {
  const now = opts?.now ?? Date.now
  const identity = catalogueIdentity(sourceKind, opts?.env)
  const cached = catalogueCache.get(identity)
  // THE DOOR (catalogueGate): no credential, or catalogue traffic switched
  // off, means NO request — a non-event (no snapshot write, no epoch bump);
  // whatever is cached keeps serving, labelled as it stands.
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

// ── Qualification (brief — ONE owner, role receipts) ────────────────

export const APEX_GPT_ROLES = [
  'primary',
  'scribe-router',
  'scribe-implementer',
  'specialist',
  // the Concourse coordinator seat's role —
  // qualification receipts gate live use exactly like every role.
  'coordinator',
] as const
export type ApexGptRole = (typeof APEX_GPT_ROLES)[number]

export interface GptQualificationReceipt {
  modelId: string
  role: ApexGptRole
  sourceKind: OpenaiAccountSourceKind
  adapterDigest: string
  architectureEpoch: string
  /** Live facts backing the receipt. */
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

/** Evaluate ONE id against the qualification rule using the CACHED catalogue
 *  (cheap+sync — refresh is the caller's async act). The rule is the LIVE
 *  source's own answer: served + visible + efforts decode. (The era
 *  'below-generation-floor' arm was removed — every model the
 *  account serves is pickable.) */
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
  // LIVE visibility vocabulary:
  // 'list' = shown, 'hide' = hidden. Unknown values stay conservatively
  // hidden — but NAMED, never silent.
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

/** All currently-qualified GPT candidates for a role, from the cached
 *  catalogue, priority-ordered. The role parameter keys the
 *  receipt — role capability itself is adapter-level (one shared runtime) and
 *  is proved by the deterministic suite + live probes; a role joins this list
 *  only while its contract proof is current for the adapter digest. */
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
  // LIVE priority semantics: ASCENDING rank — 1 is the
  // top model; missing priority sorts last.
  out.sort(
    (a, b) =>
      (a.live.priority ?? Number.POSITIVE_INFINITY) -
      (b.live.priority ?? Number.POSITIVE_INFINITY),
  )
  void role
  return out
}

/** The honest per-seat GPT availability — the ONE chain the /model picker's
 *  GPT group AND the ROLES gpt states derive from (seat-rows
 *  design; states confirmed with the operator). Sync over the bounded cache;
 *  an armed+connected-but-unfetched catalogue kicks the TTL'd single-flight
 *  refresh and reports itself honestly. The `source` label is the ACCOUNT
 *  billing honesty (the lm-studio-residue law: an env key never silently
 *  wears a subscription's clothes). */
/** Typed cause for the disabled arm, so consumers branch on the CLASS of
 *  trouble instead of string-matching the operator copy:
 *    · no-account         — no subscription connected, no API key;
 *    · auth-expired       — an account resolves but its credential no longer
 *                           authenticates (revoked/rotated-away grant) — a
 *                           SIGN-IN state, never "connecting";
 *    · catalogue-pending  — first fetch in flight (genuinely connecting);
 *    · catalogue-error    — the last fetch FAILED (terminal until retried) —
 *                           the error is named, never worn as "connecting";
 *    · no-qualified-ids   — the catalogue answered; nothing passes the
 *                           visibility/effort qualification. */
export type GptSeatDisabledWhy =
  | 'no-account'
  | 'auth-expired'
  | 'catalogue-pending'
  | 'catalogue-error'
  | 'no-qualified-ids'
  /** Credentialed, but MERCURY_DISABLE_NONESSENTIAL_TRAFFIC keeps the live
   *  catalogue dark — no qualification possible, and no request made. */
  | 'traffic-off'

export type GptSeatAvailability =
  | { state: 'disabled'; why: GptSeatDisabledWhy; reason: string }
  | {
      state: 'ready'
      /** Qualified ids, live-priority order. */
      ids: string[]
      /** Account-source label (billing honesty). */
      source: string
      sourceKind: OpenaiAccountSourceKind
    }

export function getGptSeatAvailability(): GptSeatAvailability {
  const account = resolveOpenaiAccount()
  if (!account) {
    // Present-but-dead outranks absent: a sign-in whose
    // grant the AS killed (invalid_grant → blanked refresh token) is not
    // "no account" — the seat names the expiry and the one road back.
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
    // Credentialed but dark, with nothing cached to qualify from: the honest
    // state names the switch — never a "retry shortly" whose retry the door
    // would refuse.
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
    // A failed fetch must never read as "no qualified ids" — the wrong class
    // entirely (the /model action row would wear "connecting…" forever). The
    // TTL'd single-flight re-kick keeps recovery automatic without hammering.
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

// mintQualificationReceipt DELETED:
// receipts are minted at the ONE live path — qualificationStore.
// recordLiveQualification builds the persisted shape itself from an observed
// settlement; a second unconsumed minting helper was the display/dispatch-
// divergence class waiting to happen.

// ── The reasoning profile (brief — never silently clamp) ────────────────

export interface GptReasoningProfile {
  /** The wire value actually sent (undefined = omit the reasoning param). */
  wireEffort?: string
  /** Where the value came from. */
  source: 'user' | 'model-default' | 'unsupported-fallback'
  /** Set when the requested level was unavailable — the operator-visible
   * adjustment note (rule 2: state the change, never silent). */
  adjustedFrom?: string
}

// The wire-effort ORDER + nearest-below live in gptPins.ts (the pure grammar
// module) so the capability edge, the effort-policy owner (utils/effort.ts)
// and this wire profile all rank from ONE table (a second copy is
// the display/dispatch-divergence class).
export function resolveGptReasoningProfile(
  requested: string | undefined,
  live: OpenaiLiveModel,
): GptReasoningProfile {
  const supported = live.supportedReasoningEfforts
  // an EMPTY vocabulary — whether stated empty ("effort is not
  // selectable on this model") or simply not stated (a bare row; nothing to
  // verify membership against) — always OMITS the reasoning key. Sending the
  // catalogue default into an empty/unknown vocabulary was unverifiable, and
  // the display side (capabilities.gptEffortVocabularyView) claims 'default'
  // for exactly these states, so display ≡ dispatch holds.
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
    // Order-aware adjustment first (max→xhigh on a low…xhigh model); the
    // model default is only the last resort for unrankable requests.
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

/**
 * Source-truth DEFAULT context window for a gpt id from the ACTIVE account
 * source's cached live catalogue (sync + memory-cached — safe on hot paths;
 * no-account / unfetched → undefined so callers fall to pins/defaults).
 *
 * Windows are SOURCE-SPECIFIC and the served number is NOT the model page's:
 * the same id can serve a smaller default on one account source than its
 * official page states, and the source may declare a larger ceiling on some
 * rows (`max_context_window`). Never assume parity across sources or reach
 * for a remembered number — THIS accessor, over the fetched catalogue, is
 * the derivation. (Dated illustration, observed/25 on a ChatGPT
 * subscription: rows served a 272,000 default — OpenAI's then-published
 * long-context pricing boundary — while the model page stated 1,050,000.
 * Those numbers were true that day, not laws; the live row is.)
 */
export function liveGptContextWindow(modelId: string): number | undefined {
  return liveGptModel(modelId)?.contextWindow
}

/**
 * The CEILING the active source declares for a gpt id (`max_context_window`),
 * returned ONLY when it actually exceeds the default window — so callers can
 * render "this source declares up to N" without inventing a second number
 * when the row is flat (the overwhelmingly common case).
 *
 * Undefined under the same availability law as liveGptContextWindow, and
 * whenever the source states no larger ceiling. NEVER a pin fallback: the
 * static display pins are model-page facts, not observations of any account
 * source, and must never be presented as one source's reachable window.
 */
export function liveGptContextCeiling(modelId: string): number | undefined {
  const model = liveGptModel(modelId)
  if (!model) return undefined
  const { contextWindow, maxContextWindow } = model
  if (maxContextWindow === undefined) return undefined
  if (contextWindow !== undefined && maxContextWindow <= contextWindow) return undefined
  return maxContextWindow
}

/** Sync cached live-model lookup for the ACTIVE account source (same access
 *  law as liveGptContextWindow: no-account / unfetched ⇒ undefined so
 *  callers fall to pins/defaults — never a guess). */
function liveGptModel(modelId: string): OpenaiLiveModel | undefined {
  // Parse-gate FIRST: a non-GPT id answers undefined with zero account IO —
  // this lookup sits on the every-model context-window path
  // (capabilities.ts), where an Anthropic session must never pay an OpenAI
  // auth-file read. Every selectable/qualified GPT row's id parses (the
  // qualification law's own clause 3), so no live row is lost to the gate.
  // The Mercury window annotation is id dressing, never identity — a session
  // persisted as `gpt-5.6-sol[served]` still reads Sol's live row
  // (parseGptModelId strips it before parsing).
  const identity = parseGptModelId(modelId)
  if (!identity) return undefined
  // Self-primed per read (the adapter's own account law): a cached record
  // must never outlive a /logins sign-in or sign-out, so the window a row
  // paints is the ACTIVE source's truth, not the boot-time snapshot's.
  const discovery = primeOpenaiDiscovery()
  const account = discovery?.provider === 'openai' ? discovery.account : undefined
  if (!account) return undefined
  const snapshot = getCachedOpenaiCatalogue(account.kind)
  return snapshot?.models.find(m => m.id.toLowerCase() === identity.canonicalId)
}

/** the TYPED live effort-catalogue view for a gpt id, keeping
 *  the three vocabulary states distinct (the old boolean-ish accessor above
 *  collapsed known-empty into unavailable, which let the banked fallback
 *  masquerade over an explicitly effort-less model):
 *    · undefined            — live truth UNAVAILABLE (no account ·
 *                             catalogue unfetched · model absent);
 *    · { stated: true }     — the source STATED the vocabulary (possibly
 *                             empty — empty means effort is not selectable);
 *    · { stated: false }    — the model is live-listed but the source did
 *                             not state a vocabulary (bare row — unknown). */
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

/** The live default reasoning level for a gpt id (same availability law). */
export function liveGptDefaultEffort(modelId: string): string | undefined {
  return liveGptModel(modelId)?.defaultReasoningEffort
}

/** Proof seam — clears catalogue cache + in-flight state. */
export function __resetOpenaiCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
