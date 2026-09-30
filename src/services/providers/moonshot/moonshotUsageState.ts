import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { noteUsageRecordChanged } from '../../claudeAiLimits.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import {
  kimiUsagesUrl,
  moonshotApiBase,
  moonshotLoginRegion,
  moonshotStoredTokens,
  resolveMoonshotApiKey,
  resolveMoonshotDispatchCredential,
  type KimiRegion,
  type MoonshotOauthIo,
} from './moonshotAccounts.js'

export interface MoonshotUsageIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}

function usageFetch(io?: MoonshotUsageIo): { fetchImpl: typeof fetch; proxyOptions: Record<string, unknown> } {
  return {
    fetchImpl: io?.fetchImpl ?? getApiFetch(),
    proxyOptions: io?.fetchImpl ? {} : (getProxyFetchOptions() as Record<string, unknown>),
  }
}


export function moonshotBalanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${moonshotApiBase(env)}/users/me/balance`
}

export interface MoonshotObservedBalance {
  observedAtMs: number
  availableBalance: number
  voucherBalance?: number
  cashBalance?: number
}

let observed: MoonshotObservedBalance | null = null
let observedIdentity = 'none'

function activeKeyIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveMoonshotApiKey(env)?.key)
}

function dropStaleBalance(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeKeyIdentity(env)) {
    observed = null
    observedIdentity = 'none'
  }
}

export function moonshotObservedBalance(env: NodeJS.ProcessEnv = process.env): MoonshotObservedBalance | null {
  dropStaleBalance(env)
  return observed
}

export function decodeMoonshotBalance(
  body: unknown,
  nowMs: number,
): MoonshotObservedBalance | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const o = body as Record<string, unknown>
  const data =
    typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : undefined
  if (data === undefined) return undefined
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const available = num(data.available_balance)
  if (available === undefined) return undefined
  return {
    observedAtMs: nowMs,
    availableBalance: available,
    ...(num(data.voucher_balance) !== undefined ? { voucherBalance: num(data.voucher_balance)! } : {}),
    ...(num(data.cash_balance) !== undefined ? { cashBalance: num(data.cash_balance)! } : {}),
  }
}

export type MoonshotKeyProbe =
  | { state: 'confirmed'; balance: MoonshotObservedBalance }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

const PROBE_TIMEOUT_MS = 10_000

export async function fetchMoonshotBalance(key: string, io?: MoonshotUsageIo): Promise<MoonshotKeyProbe> {
  const env = io?.env ?? process.env
  const { fetchImpl, proxyOptions } = usageFetch(io)
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'moonshot', PROBE_TIMEOUT_MS, moonshotBalanceUrl(env), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': getUserAgent(),
      },
      ...proxyOptions,
    } as RequestInit)
    if (!response.ok) return { state: 'refused', status: response.status }
    const decoded = decodeMoonshotBalance(await response.json(), io?.now?.() ?? Date.now())
    if (!decoded) return { state: 'refused', status: response.status }
    observed = decoded
    observedIdentity = credentialFingerprint(key)
    return { state: 'confirmed', balance: decoded }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

const REFRESH_TTL_MS = USAGE_POLL_TTL_MS
let inFlight: Promise<MoonshotObservedBalance | null> | null = null

export function refreshMoonshotBalance(io?: MoonshotUsageIo): Promise<MoonshotObservedBalance | null> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropStaleBalance(env)
  if (!io?.force && observed !== null && now - observed.observedAtMs < REFRESH_TTL_MS) {
    return Promise.resolve(observed)
  }
  if (inFlight) return inFlight
  const work = (async (): Promise<MoonshotObservedBalance | null> => {
    await Promise.resolve()
    try {
      const key = resolveMoonshotApiKey(env)
      if (!key) return observed
      await fetchMoonshotBalance(key.key, io)
      return observed
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}


export interface KimiUsageWindow {
  name?: string
  windowMinutes?: number
  used?: number
  limit?: number
  usedRatio?: number
  resetsAtMs?: number
}

export interface KimiManagedUsage {
  observedAtMs: number
  quota?: KimiUsageWindow
  windows: KimiUsageWindow[]
  extraUsage?: { balance: string; currency: string }
}

let observedManaged: KimiManagedUsage | null = null
let lastManagedError: string | undefined
let observedManagedIdentity = 'none'

function activeSignInIdentity(): string {
  const tokens = moonshotStoredTokens()
  return credentialFingerprint(tokens?.refreshToken ?? tokens?.accessToken)
}

function dropStaleManaged(): void {
  if (observedManagedIdentity !== activeSignInIdentity()) {
    observedManaged = null
    lastManagedError = undefined
    observedManagedIdentity = 'none'
  }
}

export function kimiObservedManagedUsage(): KimiManagedUsage | null {
  dropStaleManaged()
  return observedManaged
}

export function kimiManagedUsageError(): string | undefined {
  dropStaleManaged()
  return lastManagedError
}

const TIME_UNIT_MINUTES: Record<string, number> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 24 * 60,
  TIME_UNIT_WEEK: 7 * 24 * 60,
}

function wireInt(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : undefined
  }
  return undefined
}

function wireInstant(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? value : value * 1000
  }
  return undefined
}

function decodeWindowDetail(raw: unknown, windowMinutes?: number): KimiUsageWindow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const used = wireInt(r.used)
  const limit = wireInt(r.limit)
  if (used === undefined || limit === undefined) return undefined
  const resetsAtMs = wireInstant(r.resetTime)
  return {
    ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim() } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    used,
    limit,
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function wireNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

function decodeExtraUsage(raw: unknown): KimiManagedUsage['extraUsage'] {
  const wallet = record(raw)
  const balance = record(wallet?.balance)
  if (balance?.type !== 'BOOSTER') return undefined
  const amountLeft = wireNumber(balance.amountLeft)
  if (amountLeft === undefined || !Number.isSafeInteger(amountLeft)) return undefined
  const currency = [record(wallet?.monthlyChargeLimit)?.currency, record(wallet?.monthlyUsed)?.currency]
    .find((value): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value))
  if (currency === undefined) return undefined
  const cents = amountLeft > 0 && amountLeft < 1_000_000 ? 1 : Math.round(amountLeft / 1_000_000)
  return { balance: (cents / 100).toFixed(2), currency }
}

export function decodeKimiManagedUsage(body: unknown, nowMs: number): KimiManagedUsage | undefined {
  const o = record(body)
  if (o === undefined) return undefined
  const quota = decodeWindowDetail(o.usage)
  const windows: KimiUsageWindow[] = []
  const usages = record(o.usages)
  for (const [key, name, windowMinutes] of [
    ['limit_5h', '5h', 300],
    ['limit_7d', '7d', 10080],
    ['limit_month_total', 'month', undefined],
    ['limit_month_code', 'month code', undefined],
  ] as const) {
    const entry = record(usages?.[key])
    const usedRatio = wireNumber(entry?.used_ratio)
    if (usedRatio === undefined || usedRatio < 0) continue
    const resetsAtMs = wireInstant(entry?.reset_time)
    windows.push({ name, usedRatio, ...(windowMinutes !== undefined ? { windowMinutes } : {}), ...(resetsAtMs !== undefined ? { resetsAtMs } : {}) })
  }
  if (Array.isArray(o.limits)) {
    for (const entry of o.limits) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const window = record(e.window)
      const duration = wireInt(window?.duration)
      const unit = typeof window?.timeUnit === 'string' ? TIME_UNIT_MINUTES[window.timeUnit] : undefined
      const windowMinutes =
        duration !== undefined && unit !== undefined && duration > 0 ? duration * unit : undefined
      const detail = decodeWindowDetail(e.detail, windowMinutes)
      if (detail && !windows.some(w => w.usedRatio !== undefined && w.windowMinutes === detail.windowMinutes)) windows.push(detail)
    }
  }
  const extraUsage = decodeExtraUsage(o.boosterWallet)
  if (quota === undefined && windows.length === 0 && extraUsage === undefined && o.boosterWallet !== null && usages === undefined) return undefined
  return { observedAtMs: nowMs, ...(quota ? { quota } : {}), windows, ...(extraUsage ? { extraUsage } : {}) }
}

export type KimiUsageProbe =
  | { state: 'confirmed'; usage: KimiManagedUsage }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

export async function fetchKimiManagedUsage(
  accessToken: string,
  region: KimiRegion,
  io?: MoonshotUsageIo,
): Promise<KimiUsageProbe> {
  const env = io?.env ?? process.env
  const { fetchImpl, proxyOptions } = usageFetch(io)
  dropStaleManaged()
  const identity = activeSignInIdentity()
  const fail = (message: string): void => {
    if (activeSignInIdentity() !== identity) return
    observedManagedIdentity = identity
    lastManagedError = message
    noteUsageRecordChanged()
  }
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'moonshot', PROBE_TIMEOUT_MS, kimiUsagesUrl(region, env), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': getUserAgent(),
      },
      ...proxyOptions,
    } as RequestInit)
    if (!response.ok) {
      fail(`Kimi /usages returned HTTP ${response.status}`)
      return { state: 'refused', status: response.status }
    }
    const decoded = decodeKimiManagedUsage(await response.json(), io?.now?.() ?? Date.now())
    if (!decoded) {
      fail('Kimi /usages payload undecodable')
      return { state: 'refused', status: response.status }
    }
    if (activeSignInIdentity() === identity) {
      observedManaged = decoded
      observedManagedIdentity = identity
      lastManagedError = undefined
      noteUsageRecordChanged()
    }
    return { state: 'confirmed', usage: decoded }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`Kimi /usages unavailable: ${message}`)
    return { state: 'unreachable', message }
  }
}

let managedInFlight: Promise<KimiManagedUsage | null> | null = null

export function refreshKimiManagedUsage(io?: MoonshotUsageIo & MoonshotOauthIo): Promise<KimiManagedUsage | null> {
  const now = io?.now?.() ?? Date.now()
  dropStaleManaged()
  if (!io?.force && observedManaged !== null && now - observedManaged.observedAtMs < REFRESH_TTL_MS) {
    return Promise.resolve(observedManaged)
  }
  if (managedInFlight) return managedInFlight
  const work = (async (): Promise<KimiManagedUsage | null> => {
    await Promise.resolve()
    try {
      const credential = await resolveMoonshotDispatchCredential(io)
      if (credential?.source !== 'kimi-oauth') return observedManaged
      const region = io?.region ?? moonshotLoginRegion()
      await fetchKimiManagedUsage(credential.apiKey, region, io)
      return observedManaged
    } catch {
      return observedManaged
    } finally {
      managedInFlight = null
    }
  })()
  managedInFlight = work
  return work
}

export function __resetMoonshotUsageForTest(): void {
  observed = null
  observedIdentity = 'none'
  observedManaged = null
  observedManagedIdentity = 'none'
  lastManagedError = undefined
  inFlight = null
  managedInFlight = null
}
