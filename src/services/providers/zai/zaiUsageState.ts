import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { noteUsageRecordChanged } from '../../anthropicLimits.js'
import { getUserAgent } from '../../../utils/http.js'
import { resolveZaiDispatch } from '../../../utils/router/providerDiscovery.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { usagePollTtlMs } from '../usageFreshness.js'
import { zaiApiBase } from './zaiClient.js'

export interface ZaiUsageIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}

export type ZaiAuthForm = 'raw' | 'bearer'

export interface ZaiQuotaWindow {
  kind: 'credit' | 'tool-calls'
  windowMinutes?: number
  usedPct: number
  used?: number
  limit?: number
  remaining?: number
  resetsAtMs?: number
  details?: { code: string; used: number }[]
}

export interface ZaiObservedQuota {
  observedAtMs: number
  level?: string
  windows: ZaiQuotaWindow[]
}

export interface ZaiQuotaFailure {
  kind: 'refused' | 'unreachable'
  atMs: number
  status?: number
  code?: number
  message?: string
}

export type ZaiQuotaProbe =
  | { state: 'confirmed'; quota: ZaiObservedQuota; form: ZaiAuthForm }
  | { state: 'refused'; status: number; code?: number; message?: string }
  | { state: 'unreachable'; message: string }

export type ZaiQuotaVerdict = { ok: true } | { ok: false; code?: number; message?: string }

const QUOTA_PATH = '/api/monitor/usage/quota/limit'
const PROBE_TIMEOUT_MS = 10_000
const MESSAGE_LIMIT = 80
const UNIT_MINUTES: Record<number, number> = { 3: 60, 5: 30 * 24 * 60, 6: 7 * 24 * 60 }
const CREDIT_TYPES = new Set(['CREDIT_LIMIT', 'TOKENS_LIMIT'])

export function zaiQuotaLimitUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${new URL(zaiApiBase(env, 'coding')).origin}${QUOTA_PATH}`
}

function usageFetch(io?: ZaiUsageIo): { fetchImpl: typeof fetch; proxyOptions: Record<string, unknown> } {
  return {
    fetchImpl: io?.fetchImpl ?? getApiFetch(),
    proxyOptions: io?.fetchImpl ? {} : (getProxyFetchOptions() as Record<string, unknown>),
  }
}

function wireNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
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

function wireText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text
}

export function zaiQuotaVerdict(body: unknown): ZaiQuotaVerdict {
  if (typeof body !== 'object' || body === null) return { ok: false }
  const o = body as Record<string, unknown>
  const code = wireNumber(o.code)
  const okCode = code === undefined || code === 0 || code === 200
  if (o.success !== false && okCode) return { ok: true }
  const message = wireText(o.msg) ?? wireText(o.message)
  return { ok: false, ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) }
}

export function isZaiAuthCode(code: number | undefined): boolean {
  return code === 1000 || code === 1001
}

const PLAN_EXPIRED_CODE = 1309

export function isZaiNoPlanFailure(failure: ZaiQuotaFailure): boolean {
  return failure.kind === 'refused' && !isZaiAuthCode(failure.code) && failure.code !== PLAN_EXPIRED_CODE && /coding plan/i.test(failure.message ?? '')
}

export function zaiQuotaFailureWords(failure: ZaiQuotaFailure): string {
  if (isZaiNoPlanFailure(failure)) return 'usage: not on a coding plan'
  const message = wireText(failure.message)
  if (failure.kind === 'unreachable') return `no usage read (unreachable · ${message ?? 'no answer'})`
  if (failure.code !== undefined) {
    return `no usage read (${failure.code}${message !== undefined ? ` ${message}` : ''})`
  }
  return `no usage read (HTTP ${failure.status ?? '?'})`
}

function decodeRow(raw: unknown): ZaiQuotaWindow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const type = typeof r.type === 'string' ? r.type : ''
  const kind: ZaiQuotaWindow['kind'] | undefined = CREDIT_TYPES.has(type) ? 'credit' : type === 'TIME_LIMIT' ? 'tool-calls' : undefined
  if (kind === undefined) return undefined
  const percentage = wireNumber(r.percentage)
  if (percentage === undefined) return undefined
  const unit = wireNumber(r.unit)
  const count = wireNumber(r.number)
  const unitMinutes = unit !== undefined ? UNIT_MINUTES[unit] : undefined
  const windowMinutes = unitMinutes !== undefined && count !== undefined && count > 0 ? count * unitMinutes : undefined
  const used = wireNumber(r.currentValue)
  const limit = wireNumber(r.usage)
  const remaining = wireNumber(r.remaining)
  const resetsAtMs = wireInstant(r.nextResetTime)
  const details = Array.isArray(r.usageDetails)
    ? r.usageDetails.flatMap(entry => {
        if (typeof entry !== 'object' || entry === null) return []
        const e = entry as Record<string, unknown>
        const code = typeof e.modelCode === 'string' ? e.modelCode.trim() : ''
        const count = wireNumber(e.usage)
        return code !== '' && count !== undefined ? [{ code, used: count }] : []
      })
    : []
  return {
    kind,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    usedPct: Math.min(100, Math.max(0, percentage)),
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(details.length > 0 ? { details } : {}),
  }
}

export function decodeZaiQuota(body: unknown, nowMs: number): ZaiObservedQuota | undefined {
  if (!zaiQuotaVerdict(body).ok) return undefined
  const o = body as Record<string, unknown>
  const data = typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : undefined
  if (data === undefined) return undefined
  const windows: ZaiQuotaWindow[] = []
  if (Array.isArray(data.limits)) {
    for (const entry of data.limits) {
      const row = decodeRow(entry)
      if (row) windows.push(row)
    }
  }
  if (windows.length === 0) return undefined
  const level = typeof data.level === 'string' && data.level.trim() !== '' ? data.level.trim().toLowerCase() : undefined
  return { observedAtMs: nowMs, ...(level !== undefined ? { level } : {}), windows }
}

let observed: ZaiObservedQuota | null = null
let lastFailure: ZaiQuotaFailure | null = null
let authForm: ZaiAuthForm = 'raw'
let stateIdentity = 'none'
let inFlight: Promise<ZaiObservedQuota | null> | null = null

function activeKeyIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveZaiDispatch(env)?.key)
}

function dropStale(env: NodeJS.ProcessEnv = process.env): void {
  if (stateIdentity !== activeKeyIdentity(env)) {
    observed = null
    lastFailure = null
    authForm = 'raw'
    stateIdentity = 'none'
  }
}

export function zaiObservedQuota(env: NodeJS.ProcessEnv = process.env): ZaiObservedQuota | null {
  dropStale(env)
  return observed
}

export function zaiLastQuotaFailure(env: NodeJS.ProcessEnv = process.env): ZaiQuotaFailure | null {
  dropStale(env)
  return lastFailure
}

export function zaiQuotaAuthForm(env: NodeJS.ProcessEnv = process.env): ZaiAuthForm {
  dropStale(env)
  return authForm
}

function authorizationHeader(key: string, form: ZaiAuthForm): string {
  return form === 'bearer' ? `Bearer ${key}` : key
}

async function askQuota(
  key: string,
  form: ZaiAuthForm,
  io: ZaiUsageIo | undefined,
): Promise<{ state: 'confirmed'; quota: ZaiObservedQuota } | { state: 'refused'; status: number; code?: number; message?: string; auth: boolean } | { state: 'unreachable'; message: string }> {
  const env = io?.env ?? process.env
  const { fetchImpl, proxyOptions } = usageFetch(io)
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'zai', PROBE_TIMEOUT_MS, zaiQuotaLimitUrl(env), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en',
        authorization: authorizationHeader(key, form),
        'user-agent': getUserAgent(),
      },
      ...proxyOptions,
    } as RequestInit)
    if (!response.ok) {
      return { state: 'refused', status: response.status, auth: response.status === 401 || response.status === 403 }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { state: 'refused', status: response.status, message: 'the answer was not JSON', auth: false }
    }
    const verdict = zaiQuotaVerdict(body)
    if (!verdict.ok) {
      return {
        state: 'refused',
        status: response.status,
        ...(verdict.code !== undefined ? { code: verdict.code } : {}),
        ...(verdict.message !== undefined ? { message: verdict.message } : {}),
        auth: isZaiAuthCode(verdict.code),
      }
    }
    const quota = decodeZaiQuota(body, io?.now?.() ?? Date.now())
    if (!quota) return { state: 'refused', status: response.status, message: 'the answer stated no quota row', auth: false }
    return { state: 'confirmed', quota }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchZaiQuota(key: string, io?: ZaiUsageIo): Promise<ZaiQuotaProbe> {
  const env = io?.env ?? process.env
  const identity = credentialFingerprint(key)
  if (stateIdentity !== identity) {
    observed = null
    lastFailure = null
    authForm = 'raw'
    stateIdentity = identity
  }
  let form = authForm
  let answer = await askQuota(key, form, io)
  if (answer.state === 'refused' && answer.auth) {
    form = form === 'raw' ? 'bearer' : 'raw'
    answer = await askQuota(key, form, io)
  }
  const atMs = io?.now?.() ?? Date.now()
  if (answer.state === 'confirmed') {
    observed = answer.quota
    lastFailure = null
    authForm = form
    stateIdentity = identity
    noteUsageRecordChanged()
    return { state: 'confirmed', quota: answer.quota, form }
  }
  if (answer.state === 'refused') {
    lastFailure = {
      kind: 'refused',
      atMs,
      status: answer.status,
      ...(answer.code !== undefined ? { code: answer.code } : {}),
      ...(answer.message !== undefined ? { message: answer.message } : {}),
    }
    return { state: 'refused', status: answer.status, ...(answer.code !== undefined ? { code: answer.code } : {}), ...(answer.message !== undefined ? { message: answer.message } : {}) }
  }
  lastFailure = { kind: 'unreachable', atMs, message: answer.message }
  return answer
}

export function refreshZaiQuota(io?: ZaiUsageIo): Promise<ZaiObservedQuota | null> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropStale(env)
  if (!io?.force && observed !== null && now - observed.observedAtMs < usagePollTtlMs()) {
    return Promise.resolve(observed)
  }
  if (inFlight) return inFlight
  const work = (async (): Promise<ZaiObservedQuota | null> => {
    await Promise.resolve()
    try {
      const dispatch = resolveZaiDispatch(env)
      if (dispatch?.plan !== 'coding') return observed
      await fetchZaiQuota(dispatch.key, io)
      return observed
    } catch {
      return observed
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}

export function __resetZaiUsageForTest(): void {
  observed = null
  lastFailure = null
  authForm = 'raw'
  stateIdentity = 'none'
  inFlight = null
}
