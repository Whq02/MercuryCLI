import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { signInLedgerEpoch } from '../../../utils/accounts/signInLedger.js'
import { noteUsageRecordChanged } from '../../claudeAiLimits.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { resolveXaiAccount, resolveXaiApiKey, resolveXaiCredential, resolveXaiManagementApiKey, xaiApiBase, xaiGrokProxyBase, xaiGrokProxyBillingHeaders, xaiManagementBase } from './xaiAccounts.js'
import { xaiStoredTokens, type XaiOauthIo } from './xaiOauth.js'

export const XAI_MANAGEMENT_KEY_HINT = "add a management key from the console's settings page to read usage — /logins xai"
export const XAI_MANAGEMENT_KEY_PAGE = "Optional management key from console.x.ai's settings page unlocks the team usage meter."

export interface XaiUsageIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
  reason?: 'open' | 'operator' | 'sign-in'
}

export interface XaiObservedUsage {
  observedAtMs: number
  prepaidBalanceUsd: number
  cycle: { year: number; month: number }
  usageUsd: number
  partial: boolean
  postpaidInvoiceUsd?: number
  postpaidLimitUsd?: number
}

export interface XaiUsageFailure {
  atMs: number
  kind: 'refused' | 'unreachable' | 'invalid'
  endpoint: 'inference' | 'management' | 'subscription'
  status?: number
}

export interface XaiSubscriptionCredits {
  observedAtMs: number
  usedPercent?: number
  period?: { type: string; startMs?: number; endMs?: number }
  prepaidBalanceUsd?: number
  tier?: string
}

export type XaiSubscriptionProbe =
  | { state: 'confirmed'; credits: XaiSubscriptionCredits }
  | { state: 'failed'; failure: XaiUsageFailure }

export type XaiUsageProbe =
  | { state: 'confirmed'; usage: XaiObservedUsage }
  | { state: 'failed'; failure: XaiUsageFailure }

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function cents(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) ? n / 100 : undefined
}

export function decodeXaiPrepaidBalance(body: unknown): number | undefined {
  const total = cents(object(object(body)?.total)?.val)
  return total === undefined ? undefined : -total
}

export function decodeXaiUsageSeries(body: unknown): { usd: number; partial: boolean } | undefined {
  const raw = object(body)
  if (!Array.isArray(raw?.timeSeries) || typeof raw.limitReached !== 'boolean') return undefined
  let usd = 0
  for (const series of raw.timeSeries) {
    const points = object(series)?.dataPoints
    if (!Array.isArray(points)) return undefined
    for (const point of points) {
      const p = object(point)
      if (typeof p?.timestamp !== 'string' || !Number.isFinite(Date.parse(p.timestamp))) return undefined
      if (!Array.isArray(p.values) || p.values.length !== 1 || typeof p.values[0] !== 'number' || !Number.isFinite(p.values[0])) return undefined
      usd += p.values[0]
    }
  }
  return Number.isFinite(usd) ? { usd, partial: raw.limitReached } : undefined
}

function decodeCycle(value: unknown): XaiObservedUsage['cycle'] | undefined {
  const cycle = object(value)
  const year = cycle?.year
  const month = cycle?.month
  return typeof year === 'number' && Number.isInteger(year) && year >= 1970 && year <= 9999 &&
    typeof month === 'number' && Number.isInteger(month) && month >= 1 && month <= 12
    ? { year, month } : undefined
}

export function xaiUsageRequest(cycle: XaiObservedUsage['cycle'], nowMs: number): object {
  const start = Date.UTC(cycle.year, cycle.month - 1, 1)
  const end = Math.min(nowMs, Date.UTC(cycle.year, cycle.month, 1))
  if (end <= start) throw new Error('The billing cycle has not started')
  const time = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  return {
    analyticsRequest: {
      timeRange: { startTime: time(start), endTime: time(end), timezone: 'Etc/GMT' },
      timeUnit: 'TIME_UNIT_DAY',
      values: [{ name: 'usd', aggregation: 'AGGREGATION_SUM' }],
      groupBy: [],
      filters: [],
    },
  }
}

export function xaiUsageFailureWords(failure: XaiUsageFailure): string {
  if (failure.endpoint === 'subscription') {
    if (failure.kind === 'refused') return `Grok refused the subscription pool read${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''} — /logins xai reconnects the subscription`
    if (failure.kind === 'invalid') return 'Grok subscription pool read returned an unrecognised response — no new usage recorded'
    return `Grok subscription pool read unavailable${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''} — retry /usage`
  }
  const credential = failure.endpoint === 'management' ? 'management key' : 'API key team lookup'
  if (failure.kind === 'refused') {
    return `xAI refused the ${credential} (HTTP ${failure.status}) — check the key and its team permissions; /logins xai`
  }
  if (failure.kind === 'invalid') return `xAI ${credential} usage read returned an unrecognised response — no new usage recorded`
  return `xAI ${credential} usage read unavailable${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''} — retry /usage`
}

function wireCents(value: unknown): number | undefined {
  const raw = object(value)?.val
  if (raw === undefined || raw === null) return 0
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN
  return Number.isSafeInteger(n) ? n : undefined
}

function wireInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function decodeXaiSubscriptionCredits(body: unknown, observedAtMs: number): XaiSubscriptionCredits | undefined {
  const payload = object(body)
  const config = object(payload?.config)
  if (!config) return undefined
  const period = object(config.currentPeriod ?? config.current_period)
  const type = typeof period?.type === 'string' ? period.type : undefined
  const startMs = wireInstant(period?.start ?? config.billingPeriodStart ?? config.billing_period_start)
  const endMs = wireInstant(period?.end ?? config.billingPeriodEnd ?? config.billing_period_end)
  const explicit = config.creditUsagePercent ?? config.credit_usage_percent
  let usedPercent = typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0 ? Math.min(100, explicit) : undefined
  if (usedPercent === undefined) {
    const used = wireCents(config.used)
    const limit = wireCents(config.monthlyLimit ?? config.monthly_limit)
    if (used !== undefined && limit !== undefined && limit > 0) usedPercent = Math.min(100, Math.max(0, (used / limit) * 100))
  }
  const prepaidCents = object(config.prepaidBalance ?? config.prepaid_balance) ? wireCents(config.prepaidBalance ?? config.prepaid_balance) : undefined
  const tierRaw = payload?.subscription_tier ?? payload?.subscriptionTier
  const tier = typeof tierRaw === 'string' && tierRaw.trim() !== '' && tierRaw.length <= 128 && !/[\x00-\x1f\x7f]/.test(tierRaw) ? tierRaw.trim() : undefined
  return {
    observedAtMs,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(type !== undefined || startMs !== undefined || endMs !== undefined ? { period: { type: type ?? '', ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}) } } : {}),
    ...(prepaidCents !== undefined && prepaidCents >= 0 ? { prepaidBalanceUsd: prepaidCents / 100 } : {}),
    ...(tier !== undefined ? { tier } : {}),
  }
}

export async function fetchXaiSubscriptionCredits(token: string, io?: XaiUsageIo): Promise<XaiSubscriptionProbe> {
  const env = io?.env ?? process.env
  const now = io?.now?.() ?? Date.now()
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxy = io?.fetchImpl ? {} : getProxyFetchOptions()
  const failed = (kind: XaiUsageFailure['kind'], status?: number): XaiSubscriptionProbe => ({ state: 'failed', failure: { kind, endpoint: 'subscription', atMs: now, ...(status !== undefined ? { status } : {}) } })
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'xai', 10_000, `${xaiGrokProxyBase(env)}/billing?format=credits`, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': getUserAgent(), ...xaiGrokProxyBillingHeaders() },
      ...proxy,
    } as RequestInit)
  } catch { return failed('unreachable') }
  if (!response.ok) return failed(response.status === 401 || response.status === 403 ? 'refused' : 'unreachable', response.status)
  let body: unknown
  try { body = await response.json() } catch { return failed('invalid') }
  const credits = decodeXaiSubscriptionCredits(body, now)
  return credits ? { state: 'confirmed', credits } : failed('invalid')
}

class UsageReadError extends Error {
  constructor(readonly failure: XaiUsageFailure) { super('xAI usage read failed') }
}

export async function fetchXaiUsage(apiKey: string, managementKey: string, io?: XaiUsageIo): Promise<XaiUsageProbe> {
  const env = io?.env ?? process.env
  const now = io?.now?.() ?? Date.now()
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxy = io?.fetchImpl ? {} : getProxyFetchOptions()
  let endpoint: XaiUsageFailure['endpoint'] = 'inference'
  const invalid = (): never => { throw new UsageReadError({ kind: 'invalid', endpoint, atMs: now }) }
  const read = async (url: string, key: string, body?: object): Promise<unknown> => {
    const response = await fetchWithProviderDeadline(fetchImpl, 'xai', 10_000, url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': getUserAgent(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...proxy,
    } as RequestInit)
    if (!response.ok) throw new UsageReadError({ kind: response.status === 401 || response.status === 403 ? 'refused' : 'unreachable', endpoint, atMs: now, status: response.status })
    try { return await response.json() } catch { return invalid() }
  }
  try {
    const metadata = object(await read(`${xaiApiBase(env)}/api-key`, apiKey))
    const teamId = metadata?.team_id
    if (typeof teamId !== 'string' || !teamId.trim()) return invalid()
    endpoint = 'management'
    const base = `${xaiManagementBase(env)}/v1/billing/teams/${encodeURIComponent(teamId)}`
    const balance = decodeXaiPrepaidBalance(await read(`${base}/prepaid/balance`, managementKey))
    if (balance === undefined) return invalid()
    const preview = object(await read(`${base}/postpaid/invoice/preview`, managementKey))
    const cycle = decodeCycle(preview?.billingCycle)
    if (cycle === undefined) return invalid()
    const invoiceUsd = cents(object(preview?.coreInvoice)?.amountAfterVat)
    const previewLimit = cents(preview?.effectiveSpendingLimit)
    let postpaidLimitUsd: number | undefined
    if (previewLimit !== undefined && previewLimit > 0) {
      const limits = object(object(await read(`${base}/postpaid/spending-limits`, managementKey))?.spendingLimits)
      postpaidLimitUsd = cents(object(limits?.effectiveSl)?.val)
      if (postpaidLimitUsd === undefined) return invalid()
    }
    let request: object
    try { request = xaiUsageRequest(cycle, now) } catch { return invalid() }
    const series = decodeXaiUsageSeries(await read(`${base}/usage`, managementKey, request))
    if (series === undefined) return invalid()
    return {
      state: 'confirmed',
      usage: {
        observedAtMs: io?.now?.() ?? Date.now(),
        prepaidBalanceUsd: balance,
        cycle,
        usageUsd: series.usd,
        partial: series.partial,
        ...(invoiceUsd !== undefined && (previewLimit === undefined || previewLimit > 0 || invoiceUsd > 0) ? { postpaidInvoiceUsd: invoiceUsd } : {}),
        ...(postpaidLimitUsd !== undefined ? { postpaidLimitUsd } : {}),
      },
    }
  } catch (error) {
    return { state: 'failed', failure: error instanceof UsageReadError ? error.failure : { kind: 'unreachable', endpoint, atMs: now } }
  }
}

let observed: XaiObservedUsage | null = null
let failure: XaiUsageFailure | null = null
let identity = ''
let lastAttempt: number | undefined
let generation = 0
let inFlight: { identity: string; work: Promise<XaiObservedUsage | null> } | null = null

function activeIdentity(env: NodeJS.ProcessEnv): string {
  return [credentialFingerprint(resolveXaiApiKey(env)?.key), credentialFingerprint(resolveXaiManagementApiKey(env)?.key), xaiApiBase(env), xaiManagementBase(env), signInLedgerEpoch()].join('|')
}

function syncIdentity(env: NodeJS.ProcessEnv): string {
  const next = activeIdentity(env)
  if (next !== identity) {
    identity = next
    generation += 1
    observed = null
    failure = null
    lastAttempt = undefined
    inFlight = null
    noteUsageRecordChanged()
  }
  return next
}

export function xaiObservedUsage(env: NodeJS.ProcessEnv = process.env): { usage: XaiObservedUsage | null; failure: XaiUsageFailure | null } {
  syncIdentity(env)
  return { usage: observed, failure }
}

export function refreshXaiUsage(io?: XaiUsageIo): Promise<XaiObservedUsage | null> {
  const env = io?.env ?? process.env
  const id = syncIdentity(env)
  const apiKey = resolveXaiApiKey(env)?.key
  const managementKey = resolveXaiManagementApiKey(env)?.key
  if (!apiKey || !managementKey) return Promise.resolve(null)
  if (inFlight?.identity === id) return inFlight.work
  const now = io?.now?.() ?? Date.now()
  if (!io?.force && io?.reason !== 'operator' && lastAttempt !== undefined && now - lastAttempt < USAGE_POLL_TTL_MS) return Promise.resolve(observed)
  const epoch = generation
  lastAttempt = now
  const work = (async (): Promise<XaiObservedUsage | null> => {
    await Promise.resolve()
    try {
      const result = await fetchXaiUsage(apiKey, managementKey, io)
      if (epoch !== generation || activeIdentity(env) !== id) return null
      if (result.state === 'confirmed') { observed = result.usage; failure = null }
      else failure = result.failure
      noteUsageRecordChanged()
      return observed
    } finally {
      if (epoch === generation) inFlight = null
    }
  })()
  inFlight = { identity: id, work }
  return work
}

let poolObserved: XaiSubscriptionCredits | null = null
let poolFailure: XaiUsageFailure | null = null
let poolIdentity = ''
let poolLastAttempt: number | undefined
let poolGeneration = 0
let poolInFlight: { identity: string; work: Promise<XaiSubscriptionCredits | null> } | null = null

function poolIdentityOf(env: NodeJS.ProcessEnv): string {
  const tokens = xaiStoredTokens()
  return [tokens ? 'grok-subscription' : 'none', tokens?.email ?? '', xaiGrokProxyBase(env)].join('|')
}

function syncPoolIdentity(env: NodeJS.ProcessEnv): string {
  const next = poolIdentityOf(env)
  if (next !== poolIdentity) {
    poolIdentity = next
    poolGeneration += 1
    poolObserved = null
    poolFailure = null
    poolLastAttempt = undefined
    poolInFlight = null
    noteUsageRecordChanged()
  }
  return next
}

export function xaiObservedSubscriptionCredits(env: NodeJS.ProcessEnv = process.env): { credits: XaiSubscriptionCredits | null; failure: XaiUsageFailure | null } {
  syncPoolIdentity(env)
  return { credits: poolObserved, failure: poolFailure }
}

export function refreshXaiSubscriptionCredits(io?: XaiUsageIo & XaiOauthIo): Promise<XaiSubscriptionCredits | null> {
  const env = io?.env ?? process.env
  const id = syncPoolIdentity(env)
  if (resolveXaiAccount(env)?.kind !== 'grok-subscription') return Promise.resolve(null)
  if (poolInFlight?.identity === id) return poolInFlight.work
  const now = io?.now?.() ?? Date.now()
  if (!io?.force && io?.reason !== 'operator' && io?.reason !== 'sign-in' && poolLastAttempt !== undefined && now - poolLastAttempt < USAGE_POLL_TTL_MS) return Promise.resolve(poolObserved)
  const epoch = poolGeneration
  poolLastAttempt = now
  const work = (async (): Promise<XaiSubscriptionCredits | null> => {
    await Promise.resolve()
    try {
      let result: XaiSubscriptionProbe
      try {
        const credential = await resolveXaiCredential(io)
        result = credential?.source === 'oauth'
          ? await fetchXaiSubscriptionCredits(credential.key, io)
          : { state: 'failed', failure: { kind: 'refused', endpoint: 'subscription', atMs: now } }
      } catch {
        result = { state: 'failed', failure: { kind: 'unreachable', endpoint: 'subscription', atMs: now } }
      }
      if (epoch !== poolGeneration || poolIdentityOf(env) !== id) return null
      if (result.state === 'confirmed') { poolObserved = result.credits; poolFailure = null }
      else poolFailure = result.failure
      noteUsageRecordChanged()
      return poolObserved
    } finally {
      if (epoch === poolGeneration) poolInFlight = null
    }
  })()
  poolInFlight = { identity: id, work }
  return work
}

export function __resetXaiUsageForTest(): void {
  generation += 1
  observed = null
  failure = null
  identity = ''
  lastAttempt = undefined
  inFlight = null
  poolGeneration += 1
  poolObserved = null
  poolFailure = null
  poolIdentity = ''
  poolLastAttempt = undefined
  poolInFlight = null
  noteUsageRecordChanged()
}
