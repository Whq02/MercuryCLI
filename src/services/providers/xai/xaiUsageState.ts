import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { signInLedgerEpoch } from '../../../utils/accounts/signInLedger.js'
import { noteUsageRecordChanged } from '../../claudeAiLimits.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { resolveXaiApiKey, resolveXaiManagementApiKey, xaiApiBase, xaiManagementBase } from './xaiAccounts.js'

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
  endpoint: 'inference' | 'management'
  status?: number
}

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
  const credential = failure.endpoint === 'management' ? 'management key' : 'API key team lookup'
  if (failure.kind === 'refused') {
    return `xAI refused the ${credential} (HTTP ${failure.status}) — check the key and its team permissions; /logins xai`
  }
  if (failure.kind === 'invalid') return `xAI ${credential} usage read returned an unrecognised response — no new usage recorded`
  return `xAI ${credential} usage read unavailable${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''} — retry /usage`
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

export function __resetXaiUsageForTest(): void {
  generation += 1
  observed = null
  failure = null
  identity = ''
  lastAttempt = undefined
  inFlight = null
  noteUsageRecordChanged()
}
