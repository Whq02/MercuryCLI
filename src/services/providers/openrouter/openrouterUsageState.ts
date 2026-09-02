import { getProductUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { resolveOpenrouterRequestAuth } from './openrouterAccounts.js'

const KEY_PROBE_TIMEOUT_MS = 10_000


export interface OpenrouterKeyUsage {
  label?: string
  usage?: number
  usageDaily?: number
  usageWeekly?: number
  usageMonthly?: number
  limit?: number | null
  limitRemaining?: number | null
  limitReset?: string
  isFreeTier?: boolean
  observedAtMs: number
}

let observedKeyUsage: OpenrouterKeyUsage | null = null
let lastError: string | undefined
let lastAttemptAtMs = 0
let inFlight: Promise<OpenrouterKeyUsage | null> | null = null
let observedIdentity = 'none'

const KEY_USAGE_TTL_MS = 60_000
const KEY_USAGE_FAILURE_RETRY_MS = 10_000

function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return 'none'
  return `${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}`
}

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

export function openrouterObservedKeyUsage(env: NodeJS.ProcessEnv = process.env): {
  usage: OpenrouterKeyUsage | null
  lastError?: string
} {
  dropIfStale(env)
  return { usage: observedKeyUsage, ...(lastError !== undefined ? { lastError } : {}) }
}

export function refreshOpenrouterKeyUsage(opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<OpenrouterKeyUsage | null> {
  const now = opts?.now ?? Date.now
  const env = opts?.env ?? process.env
  dropIfStale(env)
  if (!catalogueTrafficVerdict('openrouter', env).allowed) {
    return Promise.resolve(observedKeyUsage)
  }
  const window = observedKeyUsage === null && lastError ? KEY_USAGE_FAILURE_RETRY_MS : KEY_USAGE_TTL_MS
  if (!opts?.force && lastAttemptAtMs !== 0 && now() - lastAttemptAtMs < window) {
    return Promise.resolve(observedKeyUsage)
  }
  if (inFlight) return inFlight
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


export type OpenrouterLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number }
  | { state: 'clear' }

let observedLimit: { resetsAtMs: number; observedAtMs: number } | null = null

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
  }
}

export function openrouterLimitWindow(now: () => number = Date.now): OpenrouterLimitWindow {
  if (observedLimit === null || observedLimit.resetsAtMs <= now()) return { state: 'clear' }
  return {
    state: 'limited',
    resetsAtMs: observedLimit.resetsAtMs,
    observedAtMs: observedLimit.observedAtMs,
  }
}

export function openrouterObservedWall(): { resetsAtMs: number; observedAtMs: number } | null {
  return observedLimit
}

export function forgetOpenrouterObservedLimit(): void {
  observedLimit = null
}

export function __resetOpenrouterUsageStateForTest(): void {
  observedKeyUsage = null
  lastError = undefined
  lastAttemptAtMs = 0
  inFlight = null
  observedLimit = null
  observedIdentity = 'none'
}
