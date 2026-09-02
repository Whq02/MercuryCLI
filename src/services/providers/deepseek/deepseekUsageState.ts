// ============================================================================
//  providers/deepseek/deepseekUsageState — the DeepSeek billing-truth record
// The openaiLimitState pattern: ONE module-held
//  LAST-OBSERVED record + an explicit async refresh; every read is sync and
//  free, every observation carries its stamp, and absence renders as labeled
//  absence — never a fabricated figure.
//
//  Source of truth: GET {base}/user/balance (api-docs.deepseek.com/api/
//  get-user-balance, fetched) — response
//  { is_available, balance_infos: [{ currency: 'CNY'|'USD', total_balance,
//    granted_balance, topped_up_balance }] } with the amounts as STRINGS.
//  Amounts are kept as the provider's own strings (display truth — no float
//  laundering); the usage owner (providerUsage.activeSourceUsage) surfaces
//  this record for the Usage tab and the telemetry rail.
// ============================================================================
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { resolveDeepseekApiKey } from './deepseekAccounts.js'
import { deepseekBalanceUrl } from './deepseekAccounts.js'

export interface DeepseekBalanceInfo {
  currency: string
  /** Provider-stated amount strings, verbatim. */
  totalBalance: string
  grantedBalance?: string
  toppedUpBalance?: string
}

export interface DeepseekObservedBalance {
  observedAtMs: number
  isAvailable: boolean
  balances: DeepseekBalanceInfo[]
}

let observed: DeepseekObservedBalance | null = null
/** The key the observation belongs to — a balance is a fact about ONE key;
 *  a relogin under another key reads as nothing observed until its own
 *  probe answers, never the departed key's balance for the rest of the TTL. */
let observedIdentity = 'none'

function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveDeepseekApiKey(env)?.key)
}

function dropIfStale(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeIdentity(env)) {
    observed = null
    observedIdentity = 'none'
  }
}

/** Sync, free — the last-observed record for the ACTIVE key, or null
 *  (never a guess, never another key's balance). */
export function deepseekObservedBalance(env: NodeJS.ProcessEnv = process.env): DeepseekObservedBalance | null {
  dropIfStale(env)
  return observed
}

/** Proof seam. */
export function __resetDeepseekUsageForTest(): void {
  observed = null
  observedIdentity = 'none'
}

/** Decode one balance response body (exported for the usage-truth prover —
 *  exact documented field names, nothing invented). */
export function decodeDeepseekBalance(
  body: unknown,
  nowMs: number,
): DeepseekObservedBalance | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const o = body as Record<string, unknown>
  const infos = Array.isArray(o.balance_infos) ? o.balance_infos : undefined
  if (infos === undefined) return undefined
  const balances: DeepseekBalanceInfo[] = []
  for (const raw of infos) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.currency !== 'string' || typeof r.total_balance !== 'string') continue
    balances.push({
      currency: r.currency,
      totalBalance: r.total_balance,
      ...(typeof r.granted_balance === 'string' ? { grantedBalance: r.granted_balance } : {}),
      ...(typeof r.topped_up_balance === 'string' ? { toppedUpBalance: r.topped_up_balance } : {}),
    })
  }
  return {
    observedAtMs: nowMs,
    isAvailable: o.is_available === true,
    balances,
  }
}

/** The typed key probe: a REFUSED key (the platform answered and rejected
 *  it) and an UNREACHABLE platform are different facts — the /logins key
 *  leg stores nothing on a refusal and stores unverified on a dead network. */
export type DeepseekKeyProbe =
  | { state: 'confirmed'; balance: DeepseekObservedBalance }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

/** GET {base}/user/balance with an explicit key — the key never enters the
 *  record or the returned probe; a confirmed answer becomes the observed
 *  record. */
/** The probe's hard deadline (the moonshot probes' law): a black-holed host
 *  answers 'unreachable' while the key screen still owns its keys. */
const PROBE_TIMEOUT_MS = 10_000

export async function fetchDeepseekBalance(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<DeepseekKeyProbe> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  try {
    // A key probe is a bounded question; the one deadline door carries the
    // bound AND the honest breach words (field F-6.2).
    const response = await fetchWithProviderDeadline(fetchImpl, 'deepseek', PROBE_TIMEOUT_MS, deepseekBalanceUrl(io?.env ?? process.env), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': getUserAgent(),
      },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
    if (!response.ok) return { state: 'refused', status: response.status }
    const decoded = decodeDeepseekBalance(await response.json(), io?.now?.() ?? Date.now())
    if (!decoded) return { state: 'refused', status: response.status }
    observed = decoded
    // The record belongs to the key that fetched it (a probe with an
    // explicit key that is not the active one still stamps that key).
    observedIdentity = credentialFingerprint(key)
    return { state: 'confirmed', balance: decoded }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

const REFRESH_TTL_MS = 60_000
let inFlight: Promise<DeepseekObservedBalance | null> | null = null

/**
 * Refresh the observed balance (TTL-bounded, single-flight). Never throws:
 * a refused/unreachable endpoint leaves the previous observation standing
 * (its stamp says how old it is). The key never enters the record.
 */
export function refreshDeepseekBalance(io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<DeepseekObservedBalance | null> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropIfStale(env)
  if (!io?.force && observed !== null && now - observed.observedAtMs < REFRESH_TTL_MS) {
    return Promise.resolve(observed)
  }
  if (inFlight) return inFlight
  const work = (async (): Promise<DeepseekObservedBalance | null> => {
    await Promise.resolve()
    try {
      const key = resolveDeepseekApiKey(env)
      if (!key) return observed
      await fetchDeepseekBalance(key.key, io)
      return observed
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}
