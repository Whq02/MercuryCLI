import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
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
  used: number
  limit: number
  resetsAtMs?: number
}

export interface KimiManagedUsage {
  observedAtMs: number
  quota?: KimiUsageWindow
  windows: KimiUsageWindow[]
}

let observedManaged: KimiManagedUsage | null = null
let observedManagedIdentity = 'none'

function activeSignInIdentity(): string {
  const tokens = moonshotStoredTokens()
  return credentialFingerprint(tokens?.refreshToken ?? tokens?.accessToken)
}

function dropStaleManaged(): void {
  if (observedManagedIdentity !== activeSignInIdentity()) {
    observedManaged = null
    observedManagedIdentity = 'none'
  }
}

export function kimiObservedManagedUsage(): KimiManagedUsage | null {
  dropStaleManaged()
  return observedManaged
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

export function decodeKimiManagedUsage(body: unknown, nowMs: number): KimiManagedUsage | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const o = body as Record<string, unknown>
  const quota = decodeWindowDetail(o.usage)
  const windows: KimiUsageWindow[] = []
  if (Array.isArray(o.limits)) {
    for (const entry of o.limits) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const window =
        typeof e.window === 'object' && e.window !== null ? (e.window as Record<string, unknown>) : undefined
      const duration = wireInt(window?.duration)
      const unit = typeof window?.timeUnit === 'string' ? TIME_UNIT_MINUTES[window.timeUnit] : undefined
      const windowMinutes =
        duration !== undefined && unit !== undefined && duration > 0 ? duration * unit : undefined
      const detail = decodeWindowDetail(e.detail, windowMinutes)
      if (detail) windows.push(detail)
    }
  }
  if (quota === undefined && windows.length === 0) return undefined
  return { observedAtMs: nowMs, ...(quota ? { quota } : {}), windows }
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
    if (!response.ok) return { state: 'refused', status: response.status }
    const decoded = decodeKimiManagedUsage(await response.json(), io?.now?.() ?? Date.now())
    if (!decoded) return { state: 'refused', status: response.status }
    observedManaged = decoded
    observedManagedIdentity = activeSignInIdentity()
    return { state: 'confirmed', usage: decoded }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
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
  inFlight = null
  managedInFlight = null
}
