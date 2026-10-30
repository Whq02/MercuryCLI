import { getProductUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { clearOpenrouterKeyRefusal, markOpenrouterKeyRefused, markOpenrouterMintedKeyExpired, openrouterApiBase, openrouterAuthPathForDisplay, openrouterKeyRefusal, readMintedOpenrouterKey, resolveOpenrouterApiKey, resolveOpenrouterRequestAuth, type OpenrouterKeySource, type OpenrouterRequestAuth } from './openrouterAccounts.js'
import { wordsNameTheKey } from '../catalogueBody.js'

const KEY_PROBE_TIMEOUT_MS = 10_000


export interface OpenrouterBudget {
  scope: 'workspace_default_member' | 'workspace_default_key' | 'member' | 'api_key' | 'workspace' | 'key_limit'
  guardrailId?: string | null
  budgetId?: string | null
  limitUsd: number
  spendUsd: number
  remainingUsd: number
  resetInterval?: string | null
  resetsAt?: string | null
  includeByok?: boolean
}

export interface OpenrouterFreeRequests {
  used: number
  limit: number | null
  remaining: number | null
}

export interface OpenrouterKeyUsage {
  label?: string
  usage?: number
  usageDaily?: number
  usageWeekly?: number
  usageMonthly?: number
  limit?: number | null
  limitRemaining?: number | null
  limitReset?: string | null
  budgets?: OpenrouterBudget[] | null
  effectiveBudget?: OpenrouterBudget | null
  freeModelDailyRequests?: OpenrouterFreeRequests | null
  isFreeTier?: boolean
  observedAtMs: number
}

let observedKeyUsage: OpenrouterKeyUsage | null = null
let lastError: string | undefined
let lastErrorSource: OpenrouterKeySource | undefined
let lastErrorStatus: number | undefined
let lastAttemptAtMs = 0
const inFlight = new Map<string, Promise<OpenrouterKeyUsage | null>>()
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
    lastErrorStatus = undefined
    lastAttemptAtMs = 0
    observedIdentity = 'none'
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export const OPENROUTER_LOW_BALANCE_FLOOR_USD = 10

export function openrouterLowBalanceNote(usage: OpenrouterKeyUsage | null): string | undefined {
  const remaining = usage?.limitRemaining
  if (usage?.limit === null || typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining >= OPENROUTER_LOW_BALANCE_FLOOR_USD) return undefined
  const amount = Number(remaining.toFixed(2)) >= OPENROUTER_LOW_BALANCE_FLOOR_USD ? String(remaining) : remaining.toFixed(2)
  return `remaining under the key cap is $${amount} — below Mercury’s $${OPENROUTER_LOW_BALANCE_FLOOR_USD} floor; check the key cap and credits at openrouter.ai/settings/credits`
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined
}

function decodeBudget(value: unknown): OpenrouterBudget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (!['workspace_default_member', 'workspace_default_key', 'member', 'api_key', 'workspace', 'key_limit'].includes(String(row.scope))) return undefined
  const limitUsd = num(row.limit_usd)
  const spendUsd = num(row.spend_usd)
  const remainingUsd = num(row.remaining_usd)
  if (limitUsd === undefined || spendUsd === undefined || remainingUsd === undefined) return undefined
  return {
    scope: row.scope as OpenrouterBudget['scope'], limitUsd, spendUsd, remainingUsd,
    ...(nullableString(row.guardrail_id) !== undefined ? { guardrailId: nullableString(row.guardrail_id)! } : {}),
    ...(nullableString(row.budget_id) !== undefined ? { budgetId: nullableString(row.budget_id)! } : {}),
    ...(nullableString(row.reset_interval) !== undefined ? { resetInterval: nullableString(row.reset_interval)! } : {}),
    ...(nullableString(row.resets_at) !== undefined ? { resetsAt: nullableString(row.resets_at)! } : {}),
    ...(typeof row.include_byok === 'boolean' ? { includeByok: row.include_byok } : {}),
  }
}

function decodeFreeRequests(value: unknown): OpenrouterFreeRequests | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const used = num(row.used)
  const limit = row.limit === null ? null : num(row.limit)
  const remaining = row.remaining === null ? null : num(row.remaining)
  return used !== undefined && limit !== undefined && remaining !== undefined ? { used, limit, remaining } : undefined
}

function decodeKeyPayload(parsed: unknown, now: () => number): OpenrouterKeyUsage | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const data = (parsed as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  const effectiveBudget = d.effective_budget === null ? null : decodeBudget(d.effective_budget)
  const freeModelDailyRequests = d.free_model_daily_requests === null ? null : decodeFreeRequests(d.free_model_daily_requests)
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
    ...(nullableString(d.limit_reset) !== undefined ? { limitReset: nullableString(d.limit_reset)! } : {}),
    ...(Array.isArray(d.budgets) ? { budgets: d.budgets.map(decodeBudget).filter((budget): budget is OpenrouterBudget => budget !== undefined) } : d.budgets === null ? { budgets: null } : {}),
    ...(effectiveBudget !== undefined ? { effectiveBudget } : {}),
    ...(freeModelDailyRequests !== undefined ? { freeModelDailyRequests } : {}),
    ...(typeof d.is_free_tier === 'boolean' ? { isFreeTier: d.is_free_tier } : {}),
    observedAtMs: now(),
  }
}

export function openrouterObservedKeyUsage(env: NodeJS.ProcessEnv = process.env): {
  usage: OpenrouterKeyUsage | null
  lastError?: string
  errorSource?: OpenrouterKeySource
  errorStatus?: number
} {
  dropIfStale(env)
  if (lastError === undefined) {
    const refused = openrouterKeyRefusal(env)
    if (refused !== undefined) {
      return { usage: observedKeyUsage, lastError: refused.message, errorSource: refused.source, errorStatus: refused.status }
    }
  }
  return {
    usage: observedKeyUsage,
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastErrorSource !== undefined ? { errorSource: lastErrorSource } : {}),
    ...(lastErrorStatus !== undefined ? { errorStatus: lastErrorStatus } : {}),
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

export type OpenrouterKeyProbe =
  | { state: 'accepted'; usage: OpenrouterKeyUsage }
  | { state: 'refused'; status: number; message: string }
  | { state: 'unreachable'; message: string }

export async function probeOpenrouterKey(key: string, opts?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<OpenrouterKeyProbe> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'openrouter', KEY_PROBE_TIMEOUT_MS, `${openrouterApiBase(env)}/key`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, 'user-agent': getProductUserAgent() },
      ...(opts?.fetchImpl ? {} : (getProxyFetchOptions() as Record<string, unknown>)),
    } as RequestInit)
  } catch (error) {
    return { state: 'unreachable', message: (error instanceof Error ? error.message : String(error)).split(key).join('[redacted]') }
  }
  if (!response.ok) {
    const message = (await keyErrorMessage(response)).split(key).join('[redacted]')
    const refused = response.status === 401 || response.status === 403 || (response.status === 400 && wordsNameTheKey({ message }))
    return refused ? { state: 'refused', status: response.status, message } : { state: 'unreachable', message: `the key endpoint returned HTTP ${response.status}: ${message}` }
  }
  const usage = decodeKeyPayload(await response.json().catch(() => undefined), now)
  return usage ? { state: 'accepted', usage } : { state: 'unreachable', message: 'key endpoint payload undecodable' }
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
  const startIdentity = activeIdentity(env)
  const running = inFlight.get(startIdentity)
  if (running) return running
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()
  const work = (async (): Promise<OpenrouterKeyUsage | null> => {
    let auth = resolveOpenrouterRequestAuth(env)
    let identity = auth ? requestIdentity(auth) : 'none'
    try {
      for (let attempt = 0; auth && attempt < 2; attempt++) {
        const source = auth.account.keySource
        const minted = source === 'oauth' ? readMintedOpenrouterKey() : undefined
        const probed = resolveOpenrouterApiKey(env)
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
          const refusal = response.status === 401 || response.status === 403
          lastError = error
          lastErrorSource = source
          lastErrorStatus = response.status
          if (refusal && probed !== undefined && probed.source === source) markOpenrouterKeyRefused(probed, response.status, error!, now)
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
          lastErrorStatus = undefined
          return observedKeyUsage
        }
        observedKeyUsage = decoded
        lastError = undefined
        lastErrorSource = undefined
        lastErrorStatus = undefined
        if (probed !== undefined && probed.source === source) clearOpenrouterKeyRefusal(probed)
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
      lastErrorStatus = undefined
      return observedKeyUsage
    } finally {
      inFlight.delete(startIdentity)
    }
  })()
  inFlight.set(startIdentity, work)
  return work
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
  lastErrorStatus = undefined
  lastAttemptAtMs = 0
  inFlight.clear()
  observedLimit = null
  observedIdentity = 'none'
}

export function clearOpenrouterUsageLimit(): void {
  observedLimit = null
}
