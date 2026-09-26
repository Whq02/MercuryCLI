import { getProductUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { markOpenrouterMintedKeyExpired, openrouterAuthPathForDisplay, readMintedOpenrouterKey, resolveOpenrouterRequestAuth, type OpenrouterKeySource, type OpenrouterRequestAuth } from './openrouterAccounts.js'

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
let lastErrorSource: OpenrouterKeySource | undefined
let lastAttemptAtMs = 0
let inFlight: Promise<OpenrouterKeyUsage | null> | null = null
let observedIdentity = 'none'

const KEY_USAGE_TTL_MS = USAGE_POLL_TTL_MS
const KEY_USAGE_FAILURE_RETRY_MS = 10_000

function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const auth = resolveOpenrouterRequestAuth(env)
  if (!auth) return 'none'
  return requestIdentity(auth)
}

function requestIdentity(auth: OpenrouterRequestAuth): string {
  const mint = auth.account.keySource === 'oauth' ? readMintedOpenrouterKey()?.mintedAtMs : ''
  return `${openrouterAuthPathForDisplay()}:${auth.account.keySource}:${mint}:${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}`
}

function dropIfStale(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeIdentity(env)) {
    observedKeyUsage = null
    lastError = undefined
    lastErrorSource = undefined
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
  errorSource?: OpenrouterKeySource
} {
  dropIfStale(env)
  return {
    usage: observedKeyUsage,
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastErrorSource !== undefined ? { errorSource: lastErrorSource } : {}),
  }
}

async function keyErrorMessage(response: Response): Promise<string> {
  try {
    const parsed: unknown = await response.json()
    const error = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).error : undefined
    const message = typeof error === 'object' && error !== null ? (error as Record<string, unknown>).message : undefined
    if (typeof message === 'string' && message.trim()) return message.trim().replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
  } catch {}
  return `key endpoint returned HTTP ${response.status}`
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
    let auth = resolveOpenrouterRequestAuth(env)
    let identity = auth ? requestIdentity(auth) : 'none'
    try {
      for (let attempt = 0; auth && attempt < 2; attempt++) {
        const source = auth.account.keySource
        const minted = source === 'oauth' ? readMintedOpenrouterKey() : undefined
        identity = requestIdentity(auth)
        lastAttemptAtMs = now()
        observedIdentity = identity
        const response = await fetchWithProviderDeadline(fetchImpl, 'openrouter', KEY_PROBE_TIMEOUT_MS, `${auth.baseUrl}/key`, {
          method: 'GET',
          headers: { ...auth.headers, 'user-agent': getProductUserAgent() },
          ...(getProxyFetchOptions() as Record<string, unknown>),
        } as RequestInit)
        const error = response.ok ? undefined : await keyErrorMessage(response)
        const decoded = response.ok ? decodeKeyPayload(await response.json(), now) : undefined
        if (activeIdentity(env) !== identity) {
          dropIfStale(env)
          return observedKeyUsage
        }
        if (!response.ok) {
          lastError = error
          lastErrorSource = source
          if (response.status === 401 && minted && markOpenrouterMintedKeyExpired(minted, error!)) {
            observedKeyUsage = null
            auth = resolveOpenrouterRequestAuth(env)
            observedIdentity = auth ? requestIdentity(auth) : 'none'
            if (auth?.account.keySource === 'stored') continue
          }
          return observedKeyUsage
        }
        if (!decoded) {
          lastError = 'key endpoint payload undecodable'
          lastErrorSource = source
          return observedKeyUsage
        }
        observedKeyUsage = decoded
        lastError = undefined
        lastErrorSource = undefined
        return decoded
      }
      return observedKeyUsage
    } catch (error) {
      if (activeIdentity(env) !== identity) {
        dropIfStale(env)
        return observedKeyUsage
      }
      lastError = error instanceof Error ? error.message : String(error)
      lastErrorSource = auth?.account.keySource
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
  lastErrorSource = undefined
  lastAttemptAtMs = 0
  inFlight = null
  observedLimit = null
  observedIdentity = 'none'
}
