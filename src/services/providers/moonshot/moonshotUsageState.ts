// ============================================================================
//  providers/moonshot/moonshotUsageState — the Moonshot/Kimi usage truth,
//  one LAST-OBSERVED record per source (the deepseekUsageState pattern):
//  every read is sync and free, every observation carries its stamp, and
//  absence renders as labeled absence — never a fabricated figure.
//
//  · API KEY — GET {platform base}/users/me/balance (platform.kimi.ai/docs/
//    api/balance, fetched): Bearer auth; { code, data: { available_balance,
//    voucher_balance, cash_balance }, scode, status } with the amounts as
//    NUMBERS in USD (the page states the unit). available_balance ≤ 0 blocks
//    inference; voucher_balance cannot go negative; cash_balance can (owed
//    money). Amounts are kept verbatim as the provider's own numbers.
//  · KIMI SIGN-IN — GET {coding base}/usages with the bearer (MoonshotAI/
//    kimi-code packages/oauth/src/managed-usage.ts, read):
//    { usage: { used, limit, resetTime }, limits: [{ window: { duration,
//    timeUnit }, detail: { used, limit, resetTime, name? } }], boosterWallet }
//    — used/limit arrive as decimal STRINGS, resetTime as an ISO timestamp,
//    timeUnit as TIME_UNIT_MINUTE | _HOUR | _DAY | _WEEK. The overall quota
//    and each stated window decode into the same shape; boosterWallet is on
//    the wire and unread here (no surface renders it).
//  The usage owner (providerUsage.activeSourceUsage) surfaces both records.
// ============================================================================
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

// ── the API-key balance ──────────────────────────────────────────────────────

/** The balance endpoint (proof seams already applied through the base). */
export function moonshotBalanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${moonshotApiBase(env)}/users/me/balance`
}

export interface MoonshotObservedBalance {
  observedAtMs: number
  /** Provider-stated USD amounts, verbatim (documented unit: USD). */
  availableBalance: number
  voucherBalance?: number
  cashBalance?: number
}

let observed: MoonshotObservedBalance | null = null
/** The key the balance belongs to — a balance is a fact about ONE key; a
 *  relogin under another key reads as nothing observed until its own probe
 *  answers, never the departed key's balance for the rest of the TTL. */
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

/** Sync, free — the last-observed record for the ACTIVE key, or null
 *  (never a guess, never another key's balance). */
export function moonshotObservedBalance(env: NodeJS.ProcessEnv = process.env): MoonshotObservedBalance | null {
  dropStaleBalance(env)
  return observed
}

/** Decode one balance response body (exported for the usage-truth prover —
 *  exact documented field names, nothing invented; the doc's own example
 *  shows a non-zero `code` on success, so only the stated data fields
 *  gate the decode). */
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

/** The typed key probe: a REFUSED key (the platform answered and rejected
 *  it) and an UNREACHABLE platform are different facts — the /logins key
 *  leg stores nothing on a refusal and stores unverified on a dead network. */
export type MoonshotKeyProbe =
  | { state: 'confirmed'; balance: MoonshotObservedBalance }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

/** GET {platform base}/users/me/balance with an explicit key — the key
 *  never enters the record or the returned probe; a confirmed answer
 *  becomes the observed record. */
/** The probes' hard deadline: long enough for a slow platform round trip,
 *  short enough that a black-holed host answers 'unreachable' while the
 *  operator is still looking at the screen that asked. */
const PROBE_TIMEOUT_MS = 10_000

export async function fetchMoonshotBalance(key: string, io?: MoonshotUsageIo): Promise<MoonshotKeyProbe> {
  const env = io?.env ?? process.env
  const { fetchImpl, proxyOptions } = usageFetch(io)
  try {
    // A key probe is a bounded question: a black-holed host must answer
    // 'unreachable' while the login surface still owns its keys — never
    // wedge the storing state on a fetch with no deadline. The one deadline
    // door carries the bound AND the honest breach words (field F-6.2: the
    // unreachable message renders verbatim on the login surface).
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
    // The record belongs to the key that fetched it.
    observedIdentity = credentialFingerprint(key)
    return { state: 'confirmed', balance: decoded }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

/** The poll cadence is the ONE usage-freshness TTL — the words that call a
 *  read stale and the refresh that would renew it share the number. */
const REFRESH_TTL_MS = USAGE_POLL_TTL_MS
let inFlight: Promise<MoonshotObservedBalance | null> | null = null

/**
 * Refresh the observed balance (TTL-bounded, single-flight). Never throws:
 * a refused/unreachable endpoint leaves the previous observation standing
 * (its stamp says how old it is). The key never enters the record.
 */
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

// ── the Kimi sign-in's managed usage ────────────────────────────────────────

export interface KimiUsageWindow {
  /** The vendor's own name for the window when it states one. */
  name?: string
  /** The stated window length; absent on the overall quota (unstated). */
  windowMinutes?: number
  used: number
  limit: number
  resetsAtMs?: number
}

export interface KimiManagedUsage {
  observedAtMs: number
  /** The overall quota (`usage`) — present when the wire stated it whole. */
  quota?: KimiUsageWindow
  /** The stated rate windows (`limits[]`), in wire order. */
  windows: KimiUsageWindow[]
}

let observedManaged: KimiManagedUsage | null = null
/** The sign-in the managed record belongs to (the stored refresh token's
 *  digest — Kimi sign-ins rotate access tokens, the refresh token names the
 *  account): a re-sign-in under another account reads as nothing observed
 *  until its own poll answers. */
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

/** Sync, free — the last-observed managed-usage record for the ACTIVE
 *  sign-in, or null. */
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

/** A wire number: a finite number, or a decimal string (the documented
 *  shape); anything else is absent — never a guessed zero. */
function wireInt(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : undefined
  }
  return undefined
}

/** A reset instant: an ISO timestamp string (the documented shape) or an
 *  epoch number (seconds or milliseconds) — recorded only when it parses. */
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

/** Decode one /usages body (exported for the prover — the field names
 *  Moonshot's client reads, nothing invented). Undefined when neither the
 *  quota nor any window decodes. */
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

/** GET {coding base}/usages with an explicit bearer — the typed probe the
 *  sign-in leg uses to prove the fresh token live. A confirmed answer
 *  becomes the observed record. */
export async function fetchKimiManagedUsage(
  accessToken: string,
  region: KimiRegion,
  io?: MoonshotUsageIo,
): Promise<KimiUsageProbe> {
  const env = io?.env ?? process.env
  const { fetchImpl, proxyOptions } = usageFetch(io)
  try {
    // Same bounded-probe law as the balance probe above, through the same
    // deadline door.
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

/**
 * Refresh the managed-usage record for the active Kimi sign-in (TTL-bounded,
 * single-flight, never throws). The bearer comes from the ONE dispatch
 * resolver, so the meter reads the credential the wire bills; a key source
 * or no sign-in leaves the previous observation standing.
 */
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

/** Proof seam. */
export function __resetMoonshotUsageForTest(): void {
  observed = null
  observedIdentity = 'none'
  observedManaged = null
  observedManagedIdentity = 'none'
  inFlight = null
  managedInFlight = null
}
