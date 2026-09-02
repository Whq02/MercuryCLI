// ============================================================================
//  providers/openrouter/openrouterUsageState — the OpenRouter lane's usage
//  truth.
//
//  Unlike the OpenAI lane (whose usage arrives only per-response), OpenRouter
//  DOCUMENTS a polled key-truth endpoint (openrouter.ai docs api/v1 limits
//  page, fetched):
//
//    GET {api}/key  (Authorization: Bearer <key>) →
//      data { label, limit (number|null — the per-key credit cap, null =
//             uncapped), limit_reset (string|null), limit_remaining
//             (number|null), usage, usage_daily, usage_weekly,
//             usage_monthly, is_free_tier, … }
//
//  and rate-limit headers on error responses (X-RateLimit-Limit /
//  -Remaining / -Reset, Retry-After when applicable).
//
//  The honest quota model stays LAST-OBSERVED: a fact exists here only when
//  the endpoint stated it (absent ≠ zero, ever), every record carries its
//  observation stamp, and refresh is bounded + TTL'd + single-flight. ONE
//  owner: the settings Usage tab, the telemetry rail, and any dispatch-side
//  throttle read THESE records — screen and throttle can never disagree.
// ============================================================================
import { getProductUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { resolveOpenrouterRequestAuth } from './openrouterAccounts.js'

/** One deadline per key probe (the provider-call deadline law — the
 *  sibling balance/usage probes' bound); a breach lands in lastError as
 *  'timed out after 10s — openrouter did not answer'. */
const KEY_PROBE_TIMEOUT_MS = 10_000

// ── The decoded key truth (stated fields only) ──────────────────────────────

export interface OpenrouterKeyUsage {
  /** The key's label as OpenRouter stores it. */
  label?: string
  /** Credits consumed, all-time. */
  usage?: number
  usageDaily?: number
  usageWeekly?: number
  usageMonthly?: number
  /** The per-key credit cap: a number when capped, null when the endpoint
   *  STATED unlimited, absent when unstated. */
  limit?: number | null
  /** Credits available under the cap (same stated/null/absent semantics). */
  limitRemaining?: number | null
  /** The cap's stated reset cadence/date, verbatim. */
  limitReset?: string
  /** Whether the account has ever purchased credits (their definition). */
  isFreeTier?: boolean
  observedAtMs: number
}

let observedKeyUsage: OpenrouterKeyUsage | null = null
let lastError: string | undefined
let lastAttemptAtMs = 0
let inFlight: Promise<OpenrouterKeyUsage | null> | null = null
/** The credential the observation (and the TTL anchor) belongs to — a key
 *  truth is a fact about ONE key; a relogin under another key reads as
 *  nothing observed until its own poll answers, never the departed key's
 *  credits for the rest of the TTL. */
let observedIdentity = 'none'

const KEY_USAGE_TTL_MS = 60_000
const KEY_USAGE_FAILURE_RETRY_MS = 10_000

/** The active credential's identity: a one-way digest of the bearer + the
 *  base it polls; 'none' when nothing resolves. */
function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return 'none'
  return `${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}`
}

/** Forget an observation made under a credential that is no longer the
 *  active one (the departed key's facts must not repaint the new key). */
function dropIfStale(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeIdentity(env)) {
    observedKeyUsage = null
    lastError = undefined
    lastAttemptAtMs = 0
    observedIdentity = 'none'
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function decodeKeyPayload(parsed: unknown, now: () => number): OpenrouterKeyUsage | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const data = (parsed as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  return {
    ...(typeof d.label === 'string' && d.label ? { label: d.label } : {}),
    ...(num(d.usage) !== undefined ? { usage: num(d.usage)! } : {}),
    ...(num(d.usage_daily) !== undefined ? { usageDaily: num(d.usage_daily)! } : {}),
    ...(num(d.usage_weekly) !== undefined ? { usageWeekly: num(d.usage_weekly)! } : {}),
    ...(num(d.usage_monthly) !== undefined ? { usageMonthly: num(d.usage_monthly)! } : {}),
    ...(d.limit === null ? { limit: null } : num(d.limit) !== undefined ? { limit: num(d.limit)! } : {}),
    ...(d.limit_remaining === null
      ? { limitRemaining: null }
      : num(d.limit_remaining) !== undefined
        ? { limitRemaining: num(d.limit_remaining)! }
        : {}),
    ...(typeof d.limit_reset === 'string' && d.limit_reset ? { limitReset: d.limit_reset } : {}),
    ...(typeof d.is_free_tier === 'boolean' ? { isFreeTier: d.is_free_tier } : {}),
    observedAtMs: now(),
  }
}

/** The last-observed key truth (null = nothing observed yet), with the
 *  stale-but-labelled error channel. Sync + free. */
export function openrouterObservedKeyUsage(env: NodeJS.ProcessEnv = process.env): {
  usage: OpenrouterKeyUsage | null
  lastError?: string
} {
  dropIfStale(env)
  return { usage: observedKeyUsage, ...(lastError !== undefined ? { lastError } : {}) }
}

/**
 * Refresh the key truth from GET {api}/key — TTL'd, single-flight, failures
 * label the channel and never throw. No credential ⇒ resolves null with the
 * honest label.
 */
export function refreshOpenrouterKeyUsage(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<OpenrouterKeyUsage | null> {
  const now = opts?.now ?? Date.now
  const env = opts?.env ?? process.env
  dropIfStale(env)
  // THE DOOR (catalogueGate): the /key probe rides the same discovery estate
  // as the catalogue — no credential, or catalogue traffic switched off,
  // means NO request; the last observation keeps serving, labelled as it
  // stands.
  if (!catalogueTrafficVerdict('openrouter', env).allowed) {
    return Promise.resolve(observedKeyUsage)
  }
  const window = observedKeyUsage === null && lastError ? KEY_USAGE_FAILURE_RETRY_MS : KEY_USAGE_TTL_MS
  if (!opts?.force && lastAttemptAtMs !== 0 && now() - lastAttemptAtMs < window) {
    return Promise.resolve(observedKeyUsage)
  }
  if (inFlight) return inFlight
  // PROVIDER-REVIEW F2: paired client, never bare global fetch (undici law).
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()
  inFlight = (async (): Promise<OpenrouterKeyUsage | null> => {
    try {
      lastAttemptAtMs = now()
      const auth = resolveOpenrouterRequestAuth(env)
      if (!auth) {
        lastError = 'account-source-unavailable'
        return observedKeyUsage
      }
      observedIdentity = activeIdentity(env)
      const response = await fetchWithProviderDeadline(fetchImpl, 'openrouter', KEY_PROBE_TIMEOUT_MS, `${auth.baseUrl}/key`, {
        method: 'GET',
        headers: { ...auth.headers, 'user-agent': getProductUserAgent() },
        ...(getProxyFetchOptions() as Record<string, unknown>),
      } as RequestInit)
      if (!response.ok) {
        lastError = `key endpoint returned HTTP ${response.status}`
        return observedKeyUsage
      }
      const decoded = decodeKeyPayload(await response.json(), now)
      if (!decoded) {
        lastError = 'key endpoint payload undecodable'
        return observedKeyUsage
      }
      observedKeyUsage = decoded
      lastError = undefined
      return decoded
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return observedKeyUsage
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// ── Observed limit window (429/rate-header fold at the response seam) ───────

export type OpenrouterLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number }
  | { state: 'clear' }

let observedLimit: { resetsAtMs: number; observedAtMs: number } | null = null

/**
 * Fold ONE response's rate-limit facts (documented to appear on error
 * responses). Retry-After is RFC seconds-from-now; X-RateLimit-Reset is
 * recorded only when it parses as an epoch stamp (ms or s) — an ambiguous
 * value records nothing rather than a fabricated window. Never throws.
 */
export function recordOpenrouterRateHeaders(
  headers: Headers | undefined,
  now: () => number = Date.now,
): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const retryAfter = Number(headers.get('retry-after') ?? '')
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      observedLimit = { resetsAtMs: now() + retryAfter * 1000, observedAtMs: now() }
      return
    }
    const reset = Number(headers.get('x-ratelimit-reset') ?? '')
    if (!Number.isFinite(reset) || reset <= 0) return
    if (reset > 1e12) {
      observedLimit = { resetsAtMs: reset, observedAtMs: now() }
    } else if (reset > 1e9) {
      observedLimit = { resetsAtMs: reset * 1000, observedAtMs: now() }
    }
  } catch {
    /* usage observation must never fail a request */
  }
}

/** The current window: 'limited' only while the observed reset is ahead. */
export function openrouterLimitWindow(now: () => number = Date.now): OpenrouterLimitWindow {
  if (observedLimit === null || observedLimit.resetsAtMs <= now()) return { state: 'clear' }
  return {
    state: 'limited',
    resetsAtMs: observedLimit.resetsAtMs,
    observedAtMs: observedLimit.observedAtMs,
  }
}

/** The raw wall record last stated, elapsed or not (null = none observed)
 *  — the failover return law's "observed reset" read. */
export function openrouterObservedWall(): { resetsAtMs: number; observedAtMs: number } | null {
  return observedLimit
}

/** The credential behind the lane left or changed: its observed wall goes
 *  with it (the record is process-wide, not per credential). */
export function forgetOpenrouterObservedLimit(): void {
  observedLimit = null
}

/** Proof seam. */
export function __resetOpenrouterUsageStateForTest(): void {
  observedKeyUsage = null
  lastError = undefined
  lastAttemptAtMs = 0
  inFlight = null
  observedLimit = null
  observedIdentity = 'none'
}
