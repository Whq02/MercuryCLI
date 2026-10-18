import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { minimaxPlanRemainsUrl, resolveMinimaxApiKey } from './minimaxAccounts.js'
import { minimaxBaseRespFailure, minimaxPlanAnswerVerdict } from './minimaxCatalogue.js'

export const MINIMAX_BALANCE_NOTE = 'a pay-as-you-go key draws the Open Platform balance, shown at platform.minimax.io (the API states no balance to clients)'
export const MINIMAX_PLAN_ABSENT_NOTE = 'no M Plan window on this key — turns draw the pay-as-you-go balance'

type MinimaxWindowName = '5 hour' | 'weekly'

interface MinimaxPlanWindow {
  model: string
  name: MinimaxWindowName
  usedPercent: number
  status?: string
  startsAtMs?: number
  resetsAtMs?: number
  total?: number
  used?: number
}

interface MinimaxPlanUsage {
  observedAtMs: number
  windows: MinimaxPlanWindow[]
}

type MinimaxPlanProbe =
  | { state: 'confirmed'; usage: MinimaxPlanUsage }
  | { state: 'no-plan' }
  | { state: 'refused'; status: number; message?: string }
  | { state: 'invalid' }
  | { state: 'unreachable'; message: string }

interface MinimaxPlanObservation {
  usage: MinimaxPlanUsage | null
  plan: 'm-plan' | 'none' | 'unknown'
  failure: { atMs: number; kind: 'refused' | 'unreachable' | 'invalid'; status?: number; message?: string } | null
}

let observation: MinimaxPlanObservation = { usage: null, plan: 'unknown', failure: null }
let observedIdentity = 'none'

function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveMinimaxApiKey(env)?.key)
}

function dropIfStale(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeIdentity(env)) {
    observation = { usage: null, plan: 'unknown', failure: null }
    observedIdentity = 'none'
  }
}

export function minimaxObservedPlanUsage(env: NodeJS.ProcessEnv = process.env): MinimaxPlanObservation {
  dropIfStale(env)
  return observation
}

export function __resetMinimaxUsageForTest(): void {
  observation = { usage: null, plan: 'unknown', failure: null }
  observedIdentity = 'none'
  inFlight = null
  lastAttemptAtMs = 0
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  }
  return undefined
}

function percent(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function decodeMinimaxPlanUsage(body: unknown, nowMs: number): MinimaxPlanUsage | 'no-plan' | undefined {
  if (body === undefined || body === null) return 'no-plan'
  if (typeof body !== 'object') return undefined
  const remains = (body as Record<string, unknown>).model_remains
  if (remains === undefined || remains === null) return 'no-plan'
  if (!Array.isArray(remains)) return undefined
  if (remains.length === 0) return 'no-plan'
  const windows: MinimaxPlanWindow[] = []
  for (const raw of remains) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const row = raw as Record<string, unknown>
    const model = typeof row.model_name === 'string' && row.model_name.trim() !== '' ? row.model_name.trim() : 'plan'
    const interval = percent(row.current_interval_remaining_percent)
    const weekly = percent(row.current_weekly_remaining_percent)
    if (interval === undefined && weekly === undefined) return undefined
    if (interval !== undefined) {
      windows.push({
        model, name: '5 hour', usedPercent: Math.min(100, Math.max(0, 100 - interval)),
        ...(typeof row.current_interval_status === 'string' ? { status: row.current_interval_status } : {}),
        ...(epochMs(row.start_time) !== undefined ? { startsAtMs: epochMs(row.start_time)! } : {}),
        ...(epochMs(row.end_time) !== undefined ? { resetsAtMs: epochMs(row.end_time)! } : {}),
        ...(count(row.current_interval_total_count) !== undefined ? { total: count(row.current_interval_total_count)! } : {}),
        ...(count(row.current_interval_usage_count) !== undefined ? { used: count(row.current_interval_usage_count)! } : {}),
      })
    }
    if (weekly !== undefined) {
      windows.push({
        model, name: 'weekly', usedPercent: Math.min(100, Math.max(0, 100 - weekly)),
        ...(typeof row.current_weekly_status === 'string' ? { status: row.current_weekly_status } : {}),
        ...(epochMs(row.weekly_start_time) !== undefined ? { startsAtMs: epochMs(row.weekly_start_time)! } : {}),
        ...(epochMs(row.weekly_end_time) !== undefined ? { resetsAtMs: epochMs(row.weekly_end_time)! } : {}),
      })
    }
  }
  return { observedAtMs: nowMs, windows }
}

const PROBE_TIMEOUT_MS = 10_000

export async function fetchMinimaxPlanUsage(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<MinimaxPlanProbe> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  const nowMs = io?.now?.() ?? Date.now()
  let probe: MinimaxPlanProbe
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'minimax', PROBE_TIMEOUT_MS, minimaxPlanRemainsUrl(io?.env ?? process.env), {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': getUserAgent() },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const vendor = minimaxBaseRespFailure(body)
    const verdict = minimaxPlanAnswerVerdict(vendor)
    if (verdict === 'refused') probe = { state: 'refused', status: 401, message: vendor!.message }
    else if (response.status === 401) probe = { state: 'refused', status: 401, ...(vendor ? { message: vendor.message } : {}) }
    else if (response.status === 403 || response.status === 404 || vendor) probe = { state: 'no-plan' }
    else if (!response.ok) probe = { state: 'refused', status: response.status }
    else {
      const decoded = decodeMinimaxPlanUsage(body, nowMs)
      probe = decoded === undefined ? { state: 'invalid' } : decoded === 'no-plan' ? { state: 'no-plan' } : { state: 'confirmed', usage: decoded }
    }
  } catch (error) {
    probe = { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
  observedIdentity = credentialFingerprint(key)
  switch (probe.state) {
    case 'confirmed':
      observation = { usage: probe.usage, plan: 'm-plan', failure: null }
      break
    case 'no-plan':
      observation = { usage: null, plan: 'none', failure: null }
      break
    case 'refused':
      observation = { usage: null, plan: observation.plan, failure: { atMs: nowMs, kind: 'refused', status: probe.status, ...(probe.message ? { message: probe.message.split(key).join('[redacted]') } : {}) } }
      break
    case 'invalid':
      observation = { usage: null, plan: observation.plan, failure: { atMs: nowMs, kind: 'invalid' } }
      break
    case 'unreachable':
      observation = { usage: observation.usage, plan: observation.plan, failure: { atMs: nowMs, kind: 'unreachable' } }
      break
  }
  return probe
}

export function minimaxPlanFailureWords(failure: NonNullable<MinimaxPlanObservation['failure']>): string {
  if (failure.kind === 'refused') return `MiniMax refused the key on the plan read${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''}${failure.message ? ` — ${failure.message}` : ''} — /logins minimax replaces it`
  if (failure.kind === 'invalid') return 'MiniMax plan read returned an unrecognised response — no new usage recorded'
  return 'MiniMax plan read unavailable — retry /usage'
}

export function minimaxPlanWindowLine(window: MinimaxPlanWindow): string {
  const reset = window.resetsAtMs !== undefined ? ` · resets ${new Date(window.resetsAtMs).toLocaleString()}` : ''
  const limited = window.usedPercent >= 100 ? ' (limit reached)' : ''
  return `${window.model} ${window.name} ${Math.round(window.usedPercent)}%${limited}${reset}`
}

let inFlight: Promise<MinimaxPlanObservation> | null = null
let lastAttemptAtMs = 0

export function refreshMinimaxPlanUsage(io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<MinimaxPlanObservation> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropIfStale(env)
  const fresh = observation.usage !== null ? now - observation.usage.observedAtMs < USAGE_POLL_TTL_MS : observation.plan === 'none' && now - lastAttemptAtMs < USAGE_POLL_TTL_MS
  if (!io?.force && fresh) return Promise.resolve(observation)
  if (inFlight) return inFlight
  const work = (async (): Promise<MinimaxPlanObservation> => {
    await Promise.resolve()
    try {
      const key = resolveMinimaxApiKey(env)
      if (!key) return observation
      lastAttemptAtMs = now
      await fetchMinimaxPlanUsage(key.key, io)
      return observation
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}
