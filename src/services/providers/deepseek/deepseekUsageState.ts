import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { resolveDeepseekApiKey } from './deepseekAccounts.js'
import { deepseekBalanceUrl } from './deepseekAccounts.js'

export interface DeepseekBalanceInfo {
  currency: string
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

export function deepseekObservedBalance(env: NodeJS.ProcessEnv = process.env): DeepseekObservedBalance | null {
  dropIfStale(env)
  return observed
}

export function __resetDeepseekUsageForTest(): void {
  observed = null
  observedIdentity = 'none'
}

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

export type DeepseekKeyProbe =
  | { state: 'confirmed'; balance: DeepseekObservedBalance }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

const PROBE_TIMEOUT_MS = 10_000

export async function fetchDeepseekBalance(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<DeepseekKeyProbe> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  try {
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
    observedIdentity = credentialFingerprint(key)
    return { state: 'confirmed', balance: decoded }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

const REFRESH_TTL_MS = 60_000
let inFlight: Promise<DeepseekObservedBalance | null> | null = null

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
