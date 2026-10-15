import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { resolveZenApiKey, zenGoUsageUrl } from './zenAccounts.js'

export const ZEN_BALANCE_NOTE = 'the pay-as-you-go balance is shown in the OpenCode console (opencode.ai/auth → Billing); the gateway states no balance to clients'
export const ZEN_GO_ABSENT_NOTE = 'no OpenCode Go plan on this key — turns draw the pay-as-you-go balance'

export type ZenGoWindowName = '5 hour' | 'weekly' | 'monthly'

export interface ZenGoWindow {
  name: ZenGoWindowName
  status: 'ok' | 'rate-limited'
  usedPercent: number
  resetsAtMs?: number
}

export interface ZenGoUsage {
  observedAtMs: number
  windows: ZenGoWindow[]
}

export type ZenGoProbe =
  | { state: 'confirmed'; usage: ZenGoUsage }
  | { state: 'no-plan' }
  | { state: 'refused'; status: number; message?: string }
  | { state: 'invalid' }
  | { state: 'unreachable'; message: string }

export interface ZenGoObservation {
  usage: ZenGoUsage | null
  plan: 'go' | 'none' | 'unknown'
  failure: { atMs: number; kind: 'refused' | 'unreachable' | 'invalid'; status?: number } | null
}

let observation: ZenGoObservation = { usage: null, plan: 'unknown', failure: null }
let observedIdentity = 'none'

function activeIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return credentialFingerprint(resolveZenApiKey(env)?.key)
}

function dropIfStale(env: NodeJS.ProcessEnv = process.env): void {
  if (observedIdentity !== activeIdentity(env)) {
    observation = { usage: null, plan: 'unknown', failure: null }
    observedIdentity = 'none'
  }
}

export function zenObservedGoUsage(env: NodeJS.ProcessEnv = process.env): ZenGoObservation {
  dropIfStale(env)
  return observation
}

export function __resetZenUsageForTest(): void {
  observation = { usage: null, plan: 'unknown', failure: null }
  observedIdentity = 'none'
  inFlight = null
}

const WINDOW_KEYS: ReadonlyArray<{ key: 'rolling' | 'weekly' | 'monthly'; name: ZenGoWindowName }> = [
  { key: 'rolling', name: '5 hour' },
  { key: 'weekly', name: 'weekly' },
  { key: 'monthly', name: 'monthly' },
]

export function decodeZenGoUsage(body: unknown, nowMs: number): ZenGoUsage | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const usage = (body as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const windows: ZenGoWindow[] = []
  for (const { key, name } of WINDOW_KEYS) {
    const raw = (usage as Record<string, unknown>)[key]
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    if (typeof row.percent !== 'number' || !Number.isFinite(row.percent)) return undefined
    const status = row.status === 'rate-limited' ? 'rate-limited' : row.status === 'ok' ? 'ok' : undefined
    if (status === undefined) return undefined
    const resets = typeof row.resetsAt === 'string' ? Date.parse(row.resetsAt) : Number.NaN
    windows.push({ name, status, usedPercent: Math.max(0, row.percent), ...(Number.isFinite(resets) ? { resetsAtMs: resets } : {}) })
  }
  if (windows.length === 0) return undefined
  return { observedAtMs: nowMs, windows }
}

export function zenGoErrorType(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null) return undefined
  const type = (error as Record<string, unknown>).type
  return typeof type === 'string' ? type : undefined
}

export function zenGoErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' ? message : undefined
}

const PROBE_TIMEOUT_MS = 10_000

export async function fetchZenGoUsage(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<ZenGoProbe> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  const nowMs = io?.now?.() ?? Date.now()
  let probe: ZenGoProbe
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'zen', PROBE_TIMEOUT_MS, zenGoUsageUrl(io?.env ?? process.env), {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': getProductUserAgent() },
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (response.status === 403 && zenGoErrorType(body) === 'EntitlementError') probe = { state: 'no-plan' }
    else if (!response.ok) probe = { state: 'refused', status: response.status, ...(zenGoErrorMessage(body) ? { message: zenGoErrorMessage(body) } : {}) }
    else {
      const decoded = decodeZenGoUsage(body, nowMs)
      probe = decoded ? { state: 'confirmed', usage: decoded } : { state: 'invalid' }
    }
  } catch (error) {
    probe = { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
  observedIdentity = credentialFingerprint(key)
  switch (probe.state) {
    case 'confirmed':
      observation = { usage: probe.usage, plan: 'go', failure: null }
      break
    case 'no-plan':
      observation = { usage: null, plan: 'none', failure: null }
      break
    case 'refused':
      observation = { usage: null, plan: observation.plan, failure: { atMs: nowMs, kind: 'refused', status: probe.status } }
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

export function zenGoFailureWords(failure: NonNullable<ZenGoObservation['failure']>): string {
  if (failure.kind === 'refused') return `OpenCode Zen refused the key on the usage read${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''} — /logins zen replaces it`
  if (failure.kind === 'invalid') return 'OpenCode Zen usage read returned an unrecognised response — no new usage recorded'
  return 'OpenCode Zen usage read unavailable — retry /usage'
}

export function zenGoWindowLine(window: ZenGoWindow): string {
  const reset = window.resetsAtMs !== undefined ? ` · resets ${new Date(window.resetsAtMs).toLocaleString()}` : ''
  return `Go ${window.name} ${Math.round(window.usedPercent)}%${window.status === 'rate-limited' ? ' (limit reached)' : ''}${reset}`
}

let inFlight: Promise<ZenGoObservation> | null = null
let lastAttemptAtMs = 0

export function refreshZenGoUsage(io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<ZenGoObservation> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropIfStale(env)
  const fresh = observation.usage !== null ? now - observation.usage.observedAtMs < USAGE_POLL_TTL_MS : observation.plan === 'none' && now - lastAttemptAtMs < USAGE_POLL_TTL_MS
  if (!io?.force && fresh) return Promise.resolve(observation)
  if (inFlight) return inFlight
  const work = (async (): Promise<ZenGoObservation> => {
    await Promise.resolve()
    try {
      const key = resolveZenApiKey(env)
      if (!key) return observation
      lastAttemptAtMs = now
      await fetchZenGoUsage(key.key, io)
      return observation
    } finally {
      inFlight = null
    }
  })()
  inFlight = work
  return work
}
