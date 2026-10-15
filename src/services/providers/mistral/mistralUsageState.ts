import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { signInLedgerEpoch } from '../../../utils/accounts/signInLedger.js'
import { noteUsageRecordChanged } from '../../anthropicLimits.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import { mistralApiBase, mistralKeyHeaders, resolveMistralAdminApiKey, resolveMistralApiKey } from './mistralAccounts.js'

export const MISTRAL_ADMIN_KEY_HINT = 'usage is read with an Admin API key (Enterprise plans, backoffice.mistral.ai) — /logins mistral adds one; the session ledger counts this key’s tokens; console.mistral.ai shows the plan’s included monthly usage'
export const MISTRAL_ADMIN_KEY_PAGE = 'Optional Admin API key from backoffice.mistral.ai (Enterprise plans) unlocks the organisation usage meter and spend limit.'
export const MISTRAL_USAGE_ABSENCE = 'a standard Mistral API key reads no usage, balance or credits endpoint — the console (console.mistral.ai) shows the included monthly usage; the Admin API that reports it needs an Admin API key'

export interface MistralUsageIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
  reason?: 'open' | 'operator' | 'sign-in'
}

export interface MistralIdentity {
  id: string
  email?: string
  name?: string
  organization?: string
  workspace?: string
}

export interface MistralObservedLimits {
  observedAtMs: number
  currency: string
  usage?: number
  vibeUsage?: number
  totalUsage?: number
  usageLimit?: number
  monthlyLimitReached: boolean
  noMonthlyLimit: boolean
  lastPaymentFailure: boolean
  requestsPerSecond?: number
}

export interface MistralUsageFailure {
  atMs: number
  kind: 'refused' | 'unreachable' | 'invalid'
  endpoint: 'identity' | 'admin'
  status?: number
}

export type MistralIdentityProbe =
  | { state: 'confirmed'; identity: MistralIdentity }
  | { state: 'failed'; failure: MistralUsageFailure }

export type MistralLimitsProbe =
  | { state: 'confirmed'; limits: MistralObservedLimits }
  | { state: 'failed'; failure: MistralUsageFailure }

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const money = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

export function decodeMistralIdentity(body: unknown): MistralIdentity | undefined {
  const row = object(body)
  if (!row || typeof row.id !== 'string' || row.id.trim() === '') return undefined
  const name = [row.first_name, row.last_name].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' ')
  const organization = object(row.organization)?.name
  const workspace = object(row.workspace)?.name
  return {
    id: row.id.trim(),
    ...(typeof row.email === 'string' && row.email.trim() !== '' ? { email: row.email.trim() } : {}),
    ...(name !== '' ? { name } : {}),
    ...(typeof organization === 'string' && organization.trim() !== '' ? { organization: organization.trim() } : {}),
    ...(typeof workspace === 'string' && workspace.trim() !== '' ? { workspace: workspace.trim() } : {}),
  }
}

export function decodeMistralSpendLimit(body: unknown, observedAtMs: number): MistralObservedLimits | undefined {
  const limits = object(object(body)?.limits)
  if (!limits) return undefined
  const completion = object(limits.completion)
  if (!completion || typeof completion.monthly_limit_reached !== 'boolean') return undefined
  const usage = money(completion.usage)
  const vibeUsage = money(completion.vibe_usage)
  const totalUsage = money(completion.total_usage)
  const usageLimit = money(completion.usage_limit)
  return {
    observedAtMs,
    currency: typeof limits.currency === 'string' && limits.currency.trim() !== '' ? limits.currency.trim() : 'USD',
    ...(usage !== undefined ? { usage } : {}),
    ...(vibeUsage !== undefined ? { vibeUsage } : {}),
    ...(totalUsage !== undefined ? { totalUsage } : {}),
    ...(usageLimit !== undefined ? { usageLimit } : {}),
    monthlyLimitReached: completion.monthly_limit_reached,
    noMonthlyLimit: completion.no_monthly_limit === true,
    lastPaymentFailure: limits.last_payment_failure === true,
  }
}

export function decodeMistralRateLimit(body: unknown): number | undefined {
  const rps = object(body)?.requests_per_second
  return typeof rps === 'number' && Number.isFinite(rps) && rps >= 0 ? rps : undefined
}

export function mistralUsageFailureWords(failure: MistralUsageFailure): string {
  const road = failure.endpoint === 'admin' ? 'Admin API key' : 'API key identity read'
  if (failure.kind === 'refused') {
    return failure.endpoint === 'admin'
      ? `Mistral refused the Admin API key (HTTP ${failure.status}) — an Admin API key comes from backoffice.mistral.ai and names one organisation; /logins mistral replaces it`
      : `Mistral refused the API key (HTTP ${failure.status}) — /logins mistral replaces it`
  }
  if (failure.kind === 'invalid') return `Mistral ${road} returned an unrecognised response — no new usage recorded`
  return `Mistral ${road} unavailable${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''} — retry /usage`
}

class UsageReadError extends Error {
  constructor(readonly failure: MistralUsageFailure) { super('Mistral usage read failed') }
}

async function readJson(url: string, key: string, endpoint: MistralUsageFailure['endpoint'], io: MistralUsageIo | undefined, now: number): Promise<unknown> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const response = await fetchWithProviderDeadline(fetchImpl, 'mistral', 10_000, url, {
    method: 'GET', redirect: 'error',
    headers: { accept: 'application/json', 'user-agent': getUserAgent(), ...mistralKeyHeaders(key) },
    ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
  } as RequestInit)
  if (!response.ok) throw new UsageReadError({ kind: response.status === 401 || response.status === 403 ? 'refused' : 'unreachable', endpoint, atMs: now, status: response.status })
  try { return await response.json() } catch { throw new UsageReadError({ kind: 'invalid', endpoint, atMs: now }) }
}

export async function fetchMistralIdentity(apiKey: string, io?: MistralUsageIo): Promise<MistralIdentityProbe> {
  const env = io?.env ?? process.env
  const now = io?.now?.() ?? Date.now()
  try {
    const identity = decodeMistralIdentity(await readJson(`${mistralApiBase(env)}/users/me`, apiKey, 'identity', io, now))
    if (!identity) throw new UsageReadError({ kind: 'invalid', endpoint: 'identity', atMs: now })
    return { state: 'confirmed', identity }
  } catch (error) {
    return { state: 'failed', failure: error instanceof UsageReadError ? error.failure : { kind: 'unreachable', endpoint: 'identity', atMs: now } }
  }
}

export async function fetchMistralLimits(adminKey: string, io?: MistralUsageIo): Promise<MistralLimitsProbe> {
  const env = io?.env ?? process.env
  const now = io?.now?.() ?? Date.now()
  try {
    const base = `${mistralApiBase(env)}/admin`
    const limits = decodeMistralSpendLimit(await readJson(`${base}/spend-limit`, adminKey, 'admin', io, now), io?.now?.() ?? Date.now())
    if (!limits) throw new UsageReadError({ kind: 'invalid', endpoint: 'admin', atMs: now })
    let requestsPerSecond: number | undefined
    try {
      requestsPerSecond = decodeMistralRateLimit(await readJson(`${base}/rate-limit`, adminKey, 'admin', io, now))
    } catch {
      requestsPerSecond = undefined
    }
    return { state: 'confirmed', limits: { ...limits, ...(requestsPerSecond !== undefined ? { requestsPerSecond } : {}) } }
  } catch (error) {
    return { state: 'failed', failure: error instanceof UsageReadError ? error.failure : { kind: 'unreachable', endpoint: 'admin', atMs: now } }
  }
}

let observedIdentity: MistralIdentity | null = null
let observedLimits: MistralObservedLimits | null = null
let failure: MistralUsageFailure | null = null
let identity = ''
let lastAttempt: number | undefined
let generation = 0
let inFlight: { identity: string; work: Promise<MistralObservedLimits | null> } | null = null

function activeIdentity(env: NodeJS.ProcessEnv): string {
  return [credentialFingerprint(resolveMistralApiKey(env)?.key), credentialFingerprint(resolveMistralAdminApiKey(env)?.key), mistralApiBase(env), signInLedgerEpoch()].join('|')
}

function syncIdentity(env: NodeJS.ProcessEnv): string {
  const next = activeIdentity(env)
  if (next !== identity) {
    identity = next
    generation += 1
    observedIdentity = null
    observedLimits = null
    failure = null
    lastAttempt = undefined
    inFlight = null
    noteUsageRecordChanged()
  }
  return next
}

export function mistralObservedUsage(env: NodeJS.ProcessEnv = process.env): { identity: MistralIdentity | null; limits: MistralObservedLimits | null; failure: MistralUsageFailure | null } {
  syncIdentity(env)
  return { identity: observedIdentity, limits: observedLimits, failure }
}

export function mistralObservedIdentityWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  syncIdentity(env)
  return observedIdentity?.email ?? observedIdentity?.name
}

export function refreshMistralUsage(io?: MistralUsageIo): Promise<MistralObservedLimits | null> {
  const env = io?.env ?? process.env
  const id = syncIdentity(env)
  const apiKey = resolveMistralApiKey(env)?.key
  if (!apiKey) return Promise.resolve(null)
  const adminKey = resolveMistralAdminApiKey(env)?.key
  if (inFlight?.identity === id) return inFlight.work
  const now = io?.now?.() ?? Date.now()
  if (!io?.force && io?.reason !== 'operator' && lastAttempt !== undefined && now - lastAttempt < USAGE_POLL_TTL_MS) return Promise.resolve(observedLimits)
  const epoch = generation
  lastAttempt = now
  const work = (async (): Promise<MistralObservedLimits | null> => {
    await Promise.resolve()
    try {
      const [who, limits] = await Promise.all([
        fetchMistralIdentity(apiKey, io),
        adminKey ? fetchMistralLimits(adminKey, io) : Promise.resolve<MistralLimitsProbe | null>(null),
      ])
      if (epoch !== generation || activeIdentity(env) !== id) return null
      if (who.state === 'confirmed') observedIdentity = who.identity
      if (limits === null) failure = who.state === 'failed' ? who.failure : null
      else if (limits.state === 'confirmed') { observedLimits = limits.limits; failure = who.state === 'failed' ? who.failure : null }
      else failure = limits.failure
      noteUsageRecordChanged()
      return observedLimits
    } finally {
      if (epoch === generation) inFlight = null
    }
  })()
  inFlight = { identity: id, work }
  return work
}

export function __resetMistralUsageForTest(): void {
  observedIdentity = null
  observedLimits = null
  failure = null
  identity = ''
  lastAttempt = undefined
  generation += 1
  inFlight = null
}
