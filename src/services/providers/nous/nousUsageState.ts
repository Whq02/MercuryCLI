import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { nousAccountUrl, resolveNousApiKey } from './nousAccounts.js'

export interface NousSubscriptionFacts {
  plan?: string
  tier?: number
  monthlyCharge?: number
  monthlyCredits?: number
  currentPeriodEnd?: string
  creditsRemaining?: number
  rolloverCredits?: number
}

export interface NousPaidAccessFacts {
  allowed?: boolean
  reason?: string
  hasActiveSubscription?: boolean
  totalUsableCredits?: number
  subscriptionCreditsRemaining?: number
  purchasedCreditsRemaining?: number
  memberSpendCapUsd?: number
  memberSpendUsd?: number
  memberSpendCapRemainingUsd?: number
}

export interface NousObservedAccount {
  observedAtMs: number
  accountTier?: string
  email?: string
  organisationName?: string
  subscription?: NousSubscriptionFacts
  paidAccess?: NousPaidAccessFacts
}

export interface NousAccountFailure {
  kind: 'refused' | 'unreachable'
  atMs: number
  status?: number
  message: string
}

let observed: NousObservedAccount | null = null
let failure: NousAccountFailure | null = null
let observedIdentity = 'none'

function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveNousApiKey(env)?.key)
}

function dropIfStale(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeIdentity(env)) {
    observed = null
    failure = null
    observedIdentity = 'none'
  }
}

export function nousObservedAccount(env: NodeJS.ProcessEnv = process.env): NousObservedAccount | null {
  dropIfStale(env)
  return observed
}

export function nousAccountFailure(env: NodeJS.ProcessEnv = process.env): NousAccountFailure | null {
  dropIfStale(env)
  return failure
}

export function __resetNousUsageForTest(): void {
  observed = null
  failure = null
  observedIdentity = 'none'
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function decodeNousAccount(body: unknown, nowMs: number): NousObservedAccount | undefined {
  const o = record(body)
  if (!o || typeof o.error === 'string') return undefined
  const user = record(o.user)
  const organisation = record(o.organisation)
  const subscription = record(o.subscription)
  const access = record(o.paid_service_access)
  if (!user && !subscription && !access && !organisation) return undefined
  const subscriptionFacts = subscription
    ? compact<NousSubscriptionFacts>({
        plan: str(subscription.plan),
        tier: num(subscription.tier),
        monthlyCharge: num(subscription.monthly_charge),
        monthlyCredits: num(subscription.monthly_credits),
        currentPeriodEnd: str(subscription.current_period_end),
        creditsRemaining: num(subscription.credits_remaining),
        rolloverCredits: num(subscription.rollover_credits),
      })
    : undefined
  const accessFacts = access
    ? compact<NousPaidAccessFacts>({
        allowed: bool(access.allowed),
        reason: str(access.reason),
        hasActiveSubscription: bool(access.has_active_subscription),
        totalUsableCredits: num(access.total_usable_credits),
        subscriptionCreditsRemaining: num(access.subscription_credits_remaining),
        purchasedCreditsRemaining: num(access.purchased_credits_remaining),
        memberSpendCapUsd: num(access.member_spend_cap_usd),
        memberSpendUsd: num(access.member_spend_usd),
        memberSpendCapRemainingUsd: num(access.member_spend_cap_remaining_usd),
      })
    : undefined
  return compact<NousObservedAccount>({
    observedAtMs: nowMs,
    accountTier: str(o.account_tier) ?? str(user?.account_tier),
    email: str(user?.email),
    organisationName: str(organisation?.name),
    subscription: subscriptionFacts && Object.keys(subscriptionFacts).length > 0 ? subscriptionFacts : undefined,
    paidAccess: accessFacts && Object.keys(accessFacts).length > 0 ? accessFacts : undefined,
  })
}

export type NousAccountProbe =
  | { state: 'confirmed'; account: NousObservedAccount }
  | { state: 'refused'; status: number; message: string }
  | { state: 'unreachable'; message: string }

const PROBE_TIMEOUT_MS = 10_000

export interface NousUsageIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export async function fetchNousAccount(key: string, io?: NousUsageIo): Promise<NousAccountProbe> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  const now = io?.now?.() ?? Date.now()
  const identity = credentialFingerprint(key)
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'nous', PROBE_TIMEOUT_MS, nousAccountUrl(io?.env ?? process.env), {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': getUserAgent() },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
    let body: unknown = undefined
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const described = str(record(body)?.error_description) ?? str(record(body)?.message) ?? str(record(body)?.error)
      const message = `the Portal account endpoint answered HTTP ${response.status}${described ? ` (${described})` : ''}`
      failure = { kind: 'refused', atMs: now, status: response.status, message }
      observedIdentity = identity
      return { state: 'refused', status: response.status, message }
    }
    const decoded = decodeNousAccount(body, now)
    if (!decoded) {
      const message = 'the Portal account endpoint answered without account facts'
      failure = { kind: 'refused', atMs: now, status: response.status, message }
      observedIdentity = identity
      return { state: 'refused', status: response.status, message }
    }
    observed = decoded
    failure = null
    observedIdentity = identity
    return { state: 'confirmed', account: decoded }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failure = { kind: 'unreachable', atMs: now, message }
    observedIdentity = identity
    return { state: 'unreachable', message }
  }
}

const REFRESH_TTL_MS = USAGE_POLL_TTL_MS
let inFlight: Promise<NousObservedAccount | null> | null = null

export function refreshNousAccount(io?: NousUsageIo & { force?: boolean }): Promise<NousObservedAccount | null> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropIfStale(env)
  const anchor = observed?.observedAtMs ?? failure?.atMs
  if (!io?.force && anchor !== undefined && now - anchor < REFRESH_TTL_MS) return Promise.resolve(observed)
  if (inFlight) return inFlight
  const work = (async (): Promise<NousObservedAccount | null> => {
    await Promise.resolve()
    try {
      const key = resolveNousApiKey(env)
      if (!key) return observed
      await fetchNousAccount(key.key, io)
      return observed
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}

export function nousCreditsDisplay(account: NousObservedAccount): string | undefined {
  const usable = account.paidAccess?.totalUsableCredits ?? account.subscription?.creditsRemaining
  if (usable === undefined) return undefined
  return `USD ${usable.toFixed(2)} usable credits`
}

export function nousAccountFailureWords(fail: NousAccountFailure): string {
  if (fail.kind === 'unreachable') return `the Portal account endpoint did not answer (${fail.message}) — usage shows at portal.nousresearch.com`
  if (fail.status === 401 || fail.status === 403) {
    return `${fail.message} — the Portal did not resolve this key to an account; a turn still proves the key, and usage shows at portal.nousresearch.com`
  }
  return `${fail.message} — usage shows at portal.nousresearch.com`
}
