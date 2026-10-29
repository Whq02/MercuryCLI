
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { noteUsageRecordChanged } from '../../anthropicLimits.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { USAGE_POLL_TTL_MS } from '../usageFreshness.js'
import {
  huggingfaceHubBase,
  huggingfaceStoredTokens,
  resolveHuggingfaceApiKey,
  resolveHuggingfaceDispatchCredential,
  type HuggingfaceOauthIo,
} from './huggingfaceAccounts.js'

export const HUGGINGFACE_USAGE_ABSENCE_NOTE =
  'no spend or credit API is documented for Inference Providers — the Hub states the plan and a payment method to the token (whoami-v2), not the credits used or left; huggingface.co/settings/billing is the view (monthly credits apply first, then pay-as-you-go at provider rates, no markup)'

export type HuggingfaceLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number; remaining?: number }
  | { state: 'clear' }

let observedLimit: { resetsAtMs: number; observedAtMs: number; remaining?: number } | null = null
let observedRate: { remaining: number; resetsAtMs?: number; observedAtMs: number } | null = null

export function parseRateLimitHeader(value: string | null): { remaining: number; resetSec?: number } | undefined {
  if (!value) return undefined
  let best: { remaining: number; resetSec?: number } | undefined
  for (const part of value.split(',')) {
    const r = /(?:^|;)\s*r=(\d+)/.exec(part)
    if (!r) continue
    const t = /(?:^|;)\s*t=(\d+)/.exec(part)
    const candidate = { remaining: Number(r[1]), ...(t ? { resetSec: Number(t[1]) } : {}) }
    if (!best || candidate.remaining < best.remaining) best = candidate
  }
  return best
}

export function recordHuggingfaceRateHeaders(
  headers: Headers | undefined,
  status?: number,
  now: () => number = Date.now,
): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const rate = parseRateLimitHeader(headers.get('ratelimit'))
    if (rate) {
      observedRate = {
        remaining: rate.remaining,
        ...(rate.resetSec !== undefined ? { resetsAtMs: now() + rate.resetSec * 1000 } : {}),
        observedAtMs: now(),
      }
    }
    const retryAfter = Number(headers.get('retry-after') ?? '')
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      observedLimit = { resetsAtMs: now() + retryAfter * 1000, observedAtMs: now(), ...(rate ? { remaining: rate.remaining } : {}) }
      return
    }
    if (rate && rate.remaining === 0 && rate.resetSec !== undefined) {
      observedLimit = { resetsAtMs: now() + rate.resetSec * 1000, observedAtMs: now(), remaining: 0 }
      return
    }
    const reset = Number(headers.get('x-ratelimit-reset') ?? '')
    if (Number.isFinite(reset) && reset > 0 && (status === 429 || rate?.remaining === 0)) {
      if (reset > 1e12) observedLimit = { resetsAtMs: reset, observedAtMs: now() }
      else if (reset > 1e9) observedLimit = { resetsAtMs: reset * 1000, observedAtMs: now() }
      return
    }
    if (status === 429) {
      observedLimit = { resetsAtMs: now() + 30_000, observedAtMs: now() }
    }
  } catch {
  }
}

export function huggingfaceLimitWindow(now: () => number = Date.now): HuggingfaceLimitWindow {
  if (observedLimit === null || observedLimit.resetsAtMs <= now()) return { state: 'clear' }
  return {
    state: 'limited',
    resetsAtMs: observedLimit.resetsAtMs,
    observedAtMs: observedLimit.observedAtMs,
    ...(observedLimit.remaining !== undefined ? { remaining: observedLimit.remaining } : {}),
  }
}

export function huggingfaceObservedRate(): { remaining: number; resetsAtMs?: number; observedAtMs: number } | null {
  return observedRate
}

export function huggingfaceObservedWall(): { resetsAtMs: number; observedAtMs: number } | null {
  return observedLimit === null ? null : { resetsAtMs: observedLimit.resetsAtMs, observedAtMs: observedLimit.observedAtMs }
}

export function forgetHuggingfaceObservedLimits(): void {
  observedLimit = null
  observedRate = null
  observedBilling = null
  observedFacts = null
  observedFactsIdentity = 'none'
  lastFactsFailure = null
}


export type HuggingfaceBillingState =
  | { state: 'credit-exhausted'; observedAtMs: number }
  | { state: 'clear' }

let observedBilling: { observedAtMs: number } | null = null

export function recordHuggingfaceBillingStatus(status: number | undefined, now: () => number = Date.now): void {
  if (status === undefined) return
  if (status === 402) observedBilling = { observedAtMs: now() }
  else if (status >= 200 && status < 300) observedBilling = null
}

export function huggingfaceBillingState(): HuggingfaceBillingState {
  return observedBilling === null
    ? { state: 'clear' }
    : { state: 'credit-exhausted', observedAtMs: observedBilling.observedAtMs }
}

export interface HuggingfaceUsageIo extends HuggingfaceOauthIo {
  force?: boolean
}

export interface HuggingfaceAccountFacts {
  observedAtMs: number
  accountType: string
  isPro?: boolean
  canPay?: boolean
  periodEndMs?: number
  billingMode?: string
}

export interface HuggingfaceAccountFactsFailure {
  kind: 'refused' | 'unreachable'
  atMs: number
  status?: number
  message?: string
}

export type HuggingfaceAccountFactsProbe =
  | { state: 'confirmed'; facts: HuggingfaceAccountFacts }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

export function huggingfaceWhoamiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${huggingfaceHubBase(env)}/api/whoami-v2`
}

const FACTS_PROBE_TIMEOUT_MS = 10_000
const FACTS_REFRESH_TTL_MS = USAGE_POLL_TTL_MS

let observedFacts: HuggingfaceAccountFacts | null = null
let observedFactsIdentity = 'none'
let lastFactsFailure: HuggingfaceAccountFactsFailure | null = null
let factsInFlight: Promise<HuggingfaceAccountFacts | null> | null = null

function activeCredentialIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const key = resolveHuggingfaceApiKey(env)
  if (!key) return 'none'
  if (key.source === 'oauth') {
    const tokens = huggingfaceStoredTokens()
    return credentialFingerprint(tokens?.refreshToken ?? tokens?.accessToken)
  }
  return credentialFingerprint(key.key)
}

function dropStaleFacts(env: NodeJS.ProcessEnv = process.env): void {
  if (observedFactsIdentity !== activeCredentialIdentity(env)) {
    observedFacts = null
    observedFactsIdentity = 'none'
    lastFactsFailure = null
  }
}

export function decodeHuggingfaceAccountFacts(body: unknown, nowMs: number): HuggingfaceAccountFacts | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const o = body as Record<string, unknown>
  if (typeof o.type !== 'string' || o.type.trim() === '') return undefined
  const periodEnd = typeof o.periodEnd === 'number' && Number.isFinite(o.periodEnd) && o.periodEnd > 0 ? o.periodEnd : undefined
  return {
    observedAtMs: nowMs,
    accountType: o.type,
    ...(typeof o.isPro === 'boolean' ? { isPro: o.isPro } : {}),
    ...(typeof o.canPay === 'boolean' ? { canPay: o.canPay } : {}),
    ...(periodEnd !== undefined ? { periodEndMs: periodEnd > 1e11 ? periodEnd : periodEnd * 1000 } : {}),
    ...(typeof o.billingMode === 'string' && o.billingMode.trim() !== '' ? { billingMode: o.billingMode } : {}),
  }
}

export function huggingfaceObservedAccountFacts(env: NodeJS.ProcessEnv = process.env): HuggingfaceAccountFacts | null {
  dropStaleFacts(env)
  return observedFacts
}

export function huggingfaceAccountFactsFailure(env: NodeJS.ProcessEnv = process.env): HuggingfaceAccountFactsFailure | null {
  dropStaleFacts(env)
  return lastFactsFailure
}

export function huggingfaceAccountFactsFailureWords(failure: HuggingfaceAccountFactsFailure): string {
  if (failure.kind === 'unreachable') return `no plan read (Hub unreachable · ${failure.message?.trim() || 'no answer'})`
  return `no plan read (the Hub refused the token · HTTP ${failure.status ?? '?'})`
}

export async function fetchHuggingfaceAccountFacts(token: string, io?: HuggingfaceUsageIo): Promise<HuggingfaceAccountFactsProbe> {
  const env = io?.env ?? process.env
  const now = io?.now?.() ?? Date.now()
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : (getProxyFetchOptions() as Record<string, unknown>)
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'huggingface', FACTS_PROBE_TIMEOUT_MS, huggingfaceWhoamiUrl(env), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': getUserAgent() },
      ...proxyOptions,
    } as RequestInit)
    observedFactsIdentity = activeCredentialIdentity(env)
    if (!response.ok) {
      lastFactsFailure = { kind: 'refused', atMs: now, status: response.status }
      return { state: 'refused', status: response.status }
    }
    const decoded = decodeHuggingfaceAccountFacts(await response.json(), now)
    if (!decoded) {
      lastFactsFailure = { kind: 'refused', atMs: now, status: response.status }
      return { state: 'refused', status: response.status }
    }
    observedFacts = decoded
    lastFactsFailure = null
    noteUsageRecordChanged()
    return { state: 'confirmed', facts: decoded }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    observedFactsIdentity = activeCredentialIdentity(env)
    lastFactsFailure = { kind: 'unreachable', atMs: now, message }
    return { state: 'unreachable', message }
  }
}

export function refreshHuggingfaceAccountFacts(io?: HuggingfaceUsageIo): Promise<HuggingfaceAccountFacts | null> {
  const now = io?.now?.() ?? Date.now()
  const env = io?.env ?? process.env
  dropStaleFacts(env)
  if (!io?.force) {
    if (observedFacts !== null && now - observedFacts.observedAtMs < FACTS_REFRESH_TTL_MS) return Promise.resolve(observedFacts)
    if (lastFactsFailure !== null && now - lastFactsFailure.atMs < FACTS_REFRESH_TTL_MS) return Promise.resolve(observedFacts)
  }
  if (factsInFlight) return factsInFlight
  const work = (async (): Promise<HuggingfaceAccountFacts | null> => {
    await Promise.resolve()
    try {
      const credential = await resolveHuggingfaceDispatchCredential(io)
      if (!credential) return observedFacts
      await fetchHuggingfaceAccountFacts(credential.apiKey, io)
      return observedFacts
    } catch {
      return observedFacts
    } finally {
      factsInFlight = null
    }
  })()
  factsInFlight = work
  return work
}

export function __resetHuggingfaceUsageStateForTest(): void {
  observedLimit = null
  observedRate = null
  observedBilling = null
  observedFacts = null
  observedFactsIdentity = 'none'
  lastFactsFailure = null
  factsInFlight = null
}

export function clearHuggingfaceUsageLimit(): void {
  observedLimit = null
}
