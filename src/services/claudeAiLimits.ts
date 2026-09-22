import { flagEnv } from '../substrate/flagRegistry.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { anthropicRefusalFactsOf, classifyAnthropicRefusal } from './providers/anthropicRefusal.js'
import type { UsageFeed } from './providers/usageFreshness.js'
import { processRateLimitHeaders, shouldProcessRateLimits } from './rateLimitMocking.js'


export type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_fable'
  | 'overage'

export type OverageDisabledReason =
  | 'overage_not_provisioned'
  | 'org_level_disabled'
  | 'org_level_disabled_until'
  | 'out_of_credits'
  | 'seat_tier_level_disabled'
  | 'member_level_disabled'
  | 'seat_tier_zero_credit_limit'
  | 'group_zero_credit_limit'
  | 'member_zero_credit_limit'
  | 'org_service_level_disabled'
  | 'org_service_zero_credit_limit'
  | 'no_limits_configured'
  | 'unknown'

export type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

export type ClaudeAILimits = {
  status: QuotaStatus
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number | undefined
  rateLimitType?: RateLimitType
  utilization?: number | undefined
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: OverageDisabledReason
  isUsingOverage: boolean
  surpassedThreshold?: number
}

const DEFAULT_LIMITS: ClaudeAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

export let currentLimits: ClaudeAILimits = { ...DEFAULT_LIMITS }

export const statusListeners: Set<(limits: ClaudeAILimits) => void> = new Set()

export function emitStatusChange(limits: ClaudeAILimits): void {
  currentLimits = limits
  for (const listener of statusListeners) {
    listener(limits)
  }
}

const DISPLAY_NAMES: Record<string, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_fable: 'Fable limit',
  overage: 'extra usage limit',
}

export function getRateLimitDisplayName(type: string): string {
  return DISPLAY_NAMES[type] ?? type
}


type RawWindow = { utilization: number; resets_at: number; source?: UsageFeed; observedAtMs?: number }
export type WeeklyPoolClaim = 'seven_day_fable' | 'seven_day_opus' | 'seven_day_sonnet'
export const WEEKLY_POOL_CLAIMS: readonly WeeklyPoolClaim[] = ['seven_day_fable', 'seven_day_opus', 'seven_day_sonnet']
type RawUtilization = { five_hour?: RawWindow; seven_day?: RawWindow } & Partial<Record<WeeklyPoolClaim, RawWindow>>

export function weeklyPoolClaimForModel(model: string): WeeklyPoolClaim | undefined {
  const id = model.toLowerCase()
  if (id.includes('fable') || id.includes('mythos')) return 'seven_day_fable'
  if (id.includes('opus')) return 'seven_day_opus'
  if (id.includes('sonnet')) return 'seven_day_sonnet'
  return undefined
}

let rawUtilization: RawUtilization = {}

let usageRecordVersion = 0
const usageRecordListeners = new Set<() => void>()
export function noteUsageRecordChanged(): void {
  usageRecordVersion++
  for (const listener of usageRecordListeners) {
    try {
      listener()
    } catch {
    }
  }
}
export function getUsageRecordVersion(): number {
  return usageRecordVersion
}
export function subscribeUsageRecord(listener: () => void): () => void {
  usageRecordListeners.add(listener)
  return () => {
    usageRecordListeners.delete(listener)
  }
}

let observedOwner: string | null = null

const OWNER_CACHE_MS = 2_000
let ownerCache: { owner: string; atMs: number; epoch: number } | null = null
function currentAnthropicOwner(now: () => number = Date.now): string {
  const at = now()
  if (ownerCache !== null && ownerCache.epoch === usageCredentialEpoch && at - ownerCache.atMs < OWNER_CACHE_MS) {
    return ownerCache.owner
  }
  let owner = 'none'
  try {
    const { activeWalletEntry } = require('./wallet/wallet.js') as typeof import('./wallet/wallet.js')
    const entry = activeWalletEntry('anthropic')
    owner = entry === undefined ? 'none' : entry.identity?.accountId ? `${entry.id}:${entry.identity.accountId}` : entry.id
  } catch {
  }
  ownerCache = { owner, atMs: at, epoch: usageCredentialEpoch }
  return owner
}

let ownerOverrideForTest: (() => string) | null = null
let accountNameOverrideForTest: (() => string) | null = null
export function __setAnthropicOwnerResolverForTest(resolver: (() => string) | null, accountName: (() => string) | null = null): void {
  ownerOverrideForTest = resolver
  accountNameOverrideForTest = accountName
  ownerCache = null
}
function resolveOwner(): string {
  return ownerOverrideForTest !== null ? ownerOverrideForTest() : currentAnthropicOwner()
}
function currentAnthropicAccountName(): string {
  if (accountNameOverrideForTest !== null) return accountNameOverrideForTest()
  try {
    const { activeWalletEntry } = require('./wallet/wallet.js') as typeof import('./wallet/wallet.js')
    const entry = activeWalletEntry('anthropic')
    return entry?.identity?.email ?? entry?.label ?? 'the signed-in account'
  } catch {
    return 'the signed-in account'
  }
}

function recomputeRawUtilization(headers: Headers): void {
  const next: RawUtilization = {}
  for (const [key, abbrev] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const utilizationRaw = headers.get(`anthropic-ratelimit-unified-${abbrev}-utilization`)
    const resetRaw = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    if (utilizationRaw === null || utilizationRaw === '') continue
    if (resetRaw === null || resetRaw === '') continue
    const utilization = Number(utilizationRaw)
    const resetsAt = Number(resetRaw)
    if (!Number.isFinite(utilization) || !Number.isFinite(resetsAt)) continue
    if (utilization < 0 || resetsAt < 0) continue
    next[key] = { utilization, resets_at: resetsAt, source: 'headers', observedAtMs: Date.now() }
  }
  rawUtilization = next
  observedOwner = resolveOwner()
  noteUsageRecordChanged()
}

const SEED_DEFAULT_TTL_SECONDS = 2820

let endpointUtilization: RawUtilization = {}

function normalizeEndpointWindow(
  w: { utilization: number | null; resets_at: string | null } | null | undefined,
): RawWindow | null {
  if (!w || w.utilization === null || w.resets_at === null) return null
  const utilization = w.utilization / 100
  const resetsAt = Date.parse(w.resets_at) / 1000
  if (!Number.isFinite(utilization) || !Number.isFinite(resetsAt)) return null
  if (utilization < 0 || resetsAt < 0) return null
  return { utilization, resets_at: resetsAt }
}

export function foldUtilizationFromEndpoint(
  u: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null
    seven_day?: { utilization: number | null; resets_at: string | null } | null
  } & Partial<Record<WeeklyPoolClaim, { utilization: number | null; resets_at: string | null } | null>>,
  issuedEpoch?: number,
  observedAtMs: number = Date.now(),
): void {
  if (issuedEpoch !== undefined && issuedEpoch !== usageCredentialEpoch) return
  const next: RawUtilization = {}
  const stamp = (w: RawWindow): RawWindow => ({ ...w, source: 'endpoint', observedAtMs })
  const fiveHour = normalizeEndpointWindow(u.five_hour)
  const sevenDay = normalizeEndpointWindow(u.seven_day)
  if (fiveHour) next.five_hour = stamp(fiveHour)
  if (sevenDay) next.seven_day = stamp(sevenDay)
  for (const claim of WEEKLY_POOL_CLAIMS) {
    const pool = normalizeEndpointWindow(u[claim])
    if (pool) next[claim] = stamp(pool)
  }
  endpointUtilization = next
  observedOwner = resolveOwner()
  noteUsageRecordChanged()
}

export function getRawUtilization(): RawUtilization {
  const ownerStands = observedOwner === null || observedOwner === resolveOwner()
  const live = ownerStands ? rawUtilization : {}
  const endpoint = ownerStands ? endpointUtilization : {}
  const seed = flagEnv('MERCURY_USAGE_SEED')
  if (seed === undefined && Object.keys(endpoint).length === 0) {
    return live
  }
  const copy: RawUtilization = { ...live }
  const fresher = (header: RawWindow | undefined, polled: RawWindow | undefined): RawWindow | undefined => {
    if (header === undefined) return polled
    if (polled === undefined || header.observedAtMs === undefined) return header
    return (polled.observedAtMs ?? -1) > header.observedAtMs ? polled : header
  }
  copy.five_hour = fresher(live.five_hour, endpoint.five_hour)
  copy.seven_day = fresher(live.seven_day, endpoint.seven_day)
  if (copy.five_hour === undefined) delete copy.five_hour
  if (copy.seven_day === undefined) delete copy.seven_day
  for (const claim of WEEKLY_POOL_CLAIMS) {
    const pool = endpoint[claim]
    if (pool !== undefined) copy[claim] = pool
  }
  if (seed === undefined) return copy
  for (const entry of seed.split(',')) {
    const match = /^\s*(5h|7d)=([0-9.]+)(?:@(\d+))?\s*$/.exec(entry)
    if (!match) continue
    const key = match[1] === '5h' ? 'five_hour' : 'seven_day'
    if (copy[key] !== undefined) continue
    copy[key] = {
      utilization: Number(match[2]),
      resets_at: match[3] !== undefined ? Number(match[3]) : Math.floor(Date.now() / 1000) + SEED_DEFAULT_TTL_SECONDS,
      source: 'seed',
    }
  }
  return copy
}


function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  return value === null ? undefined : value
}

type EarlyWarning = ClaudeAILimits

const TIME_RELATIVE_CONFIGS: Array<{
  claim: RateLimitType
  abbrev: '5h' | '7d'
  windowSeconds: number
  thresholds: Array<{ minUtilization: number; maxElapsedFraction: number }>
}> = [
  {
    claim: 'five_hour',
    abbrev: '5h',
    windowSeconds: 18_000,
    thresholds: [{ minUtilization: 0.9, maxElapsedFraction: 0.72 }],
  },
  {
    claim: 'seven_day',
    abbrev: '7d',
    windowSeconds: 604_800,
    thresholds: [
      { minUtilization: 0.75, maxElapsedFraction: 0.6 },
      { minUtilization: 0.5, maxElapsedFraction: 0.35 },
      { minUtilization: 0.25, maxElapsedFraction: 0.15 },
    ],
  },
]

function detectEarlyWarning(headers: Headers, fallbackAvailable: boolean): EarlyWarning | null {
  for (const [abbrev, claim] of [
    ['5h', 'five_hour'],
    ['7d', 'seven_day'],
    ['overage', 'overage'],
  ] as const) {
    const threshold = headers.get(`anthropic-ratelimit-unified-${abbrev}-surpassed-threshold`)
    if (threshold === null) continue
    const utilizationRaw = headerValue(headers, `anthropic-ratelimit-unified-${abbrev}-utilization`)
    const resetRaw = headerValue(headers, `anthropic-ratelimit-unified-${abbrev}-reset`)
    return {
      status: 'allowed_warning',
      unifiedRateLimitFallbackAvailable: fallbackAvailable,
      resetsAt: resetRaw !== undefined && resetRaw !== '' ? Number(resetRaw) : undefined,
      rateLimitType: claim as RateLimitType,
      utilization:
        utilizationRaw !== undefined && utilizationRaw !== '' ? Number(utilizationRaw) : undefined,
      isUsingOverage: false,
      surpassedThreshold: threshold === '' ? 0 : Number(threshold),
    }
  }
  const nowSeconds = Date.now() / 1000
  for (const config of TIME_RELATIVE_CONFIGS) {
    const utilizationRaw = headers.get(`anthropic-ratelimit-unified-${config.abbrev}-utilization`)
    const resetRaw = headers.get(`anthropic-ratelimit-unified-${config.abbrev}-reset`)
    if (utilizationRaw === null || resetRaw === null) continue
    const utilization = Number(utilizationRaw) || 0
    const resetsAt = Number(resetRaw) || 0
    const elapsedFraction = Math.min(
      1,
      Math.max(0, (nowSeconds - (resetsAt - config.windowSeconds)) / config.windowSeconds),
    )
    const fires = config.thresholds.some(
      pair => utilization >= pair.minUtilization && elapsedFraction <= pair.maxElapsedFraction,
    )
    if (fires) {
      return {
        status: 'allowed_warning',
        unifiedRateLimitFallbackAvailable: fallbackAvailable,
        resetsAt,
        rateLimitType: config.claim,
        utilization,
        isUsingOverage: false,
      }
    }
  }
  return null
}

export function computeNewLimitsFromHeaders(headers: Headers): ClaudeAILimits {
  const statusRaw = headerValue(headers, 'anthropic-ratelimit-unified-status')
  const status = (statusRaw === undefined || statusRaw === '' ? 'allowed' : statusRaw) as QuotaStatus
  const resetRaw = headerValue(headers, 'anthropic-ratelimit-unified-reset')
  const resetsAt = resetRaw !== undefined && resetRaw !== '' ? Number(resetRaw) : undefined
  const fallbackAvailable =
    headerValue(headers, 'anthropic-ratelimit-unified-fallback') === 'available'
  const claim = headerValue(headers, 'anthropic-ratelimit-unified-representative-claim')
  const overageStatus = headerValue(headers, 'anthropic-ratelimit-unified-overage-status')
  const overageResetRaw = headerValue(headers, 'anthropic-ratelimit-unified-overage-reset')
  const overageDisabledReason = headerValue(
    headers,
    'anthropic-ratelimit-unified-overage-disabled-reason',
  )

  const isUsingOverage =
    status === 'rejected' && (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  if (status === 'allowed' || status === 'allowed_warning') {
    const warning = detectEarlyWarning(headers, fallbackAvailable)
    if (warning !== null) return warning
  }

  const record: ClaudeAILimits = {
    status: status === 'allowed_warning' ? 'allowed' : status,
    unifiedRateLimitFallbackAvailable: fallbackAvailable,
    resetsAt,
    isUsingOverage,
  }
  if (claim !== undefined && claim !== '') record.rateLimitType = claim as RateLimitType
  if (overageStatus !== undefined && overageStatus !== '') record.overageStatus = overageStatus as QuotaStatus
  if (overageDisabledReason !== undefined && overageDisabledReason !== '') {
    record.overageDisabledReason = overageDisabledReason as OverageDisabledReason
  }
  const overageResetsAt =
    overageResetRaw !== undefined && overageResetRaw !== '' ? Number(overageResetRaw) : undefined
  if (overageResetsAt) record.overageResetsAt = overageResetsAt
  return record
}

function limitsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    key =>
      bKeys.includes(key) &&
      limitsEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}


let usageCredentialEpoch = 0

export function getUsageCredentialEpoch(): number {
  return usageCredentialEpoch
}

let windowObserved = false
let verdictOwner: string | null = null
let verdictObservedAtMs: number | null = null
let lastWindowReadKey: string | null = null

function stampVerdictOwner(observedAtMs: number = Date.now()): void {
  verdictOwner = resolveOwner()
  verdictObservedAtMs = observedAtMs
  logForDebugging(`[limits] window observed · ${currentLimits.status} · owner ${verdictOwner}`)
}
function verdictOwnerStands(): boolean {
  return verdictOwner === null || verdictOwner === resolveOwner()
}

export function claudeWindowObserved(): boolean {
  const stands = verdictOwnerStands()
  const key = windowObserved ? (stands ? 'observed' : `drift ${verdictOwner} ${resolveOwner()}`) : 'unobserved'
  if (key !== lastWindowReadKey) {
    lastWindowReadKey = key
    logForDebugging(
      windowObserved
        ? stands
          ? `[limits] window read: observed · owner ${verdictOwner}`
          : `[limits] window read: unobserved · the verdict is stamped for ${verdictOwner} and the active slot is ${resolveOwner()}`
        : '[limits] window read: unobserved · no response has spoken since the last credential change',
    )
  }
  return windowObserved && stands
}

export type AnthropicLimitVerdict = {
  status: QuotaStatus | 'unknown'
  observedAtMs?: number
  account?: string
  resetsAtMs?: number
  lapsesAtMs?: number
}

function statedResetMs(resetsAt: number | undefined): number | undefined {
  return resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : undefined
}

export function anthropicLimitVerdict(nowMs: number = Date.now()): AnthropicLimitVerdict {
  if (!verdictOwnerStands()) return { status: 'unknown' }
  if (verdictObservedAtMs === null) return { status: currentLimits.status }
  const resetsAtMs = statedResetMs(currentLimits.resetsAt)
  const lapsesAtMs = resetsAtMs ?? verdictObservedAtMs + SEED_DEFAULT_TTL_SECONDS * 1000
  if (lapsesAtMs <= nowMs) return { status: 'unknown' }
  return {
    status: currentLimits.status,
    observedAtMs: verdictObservedAtMs,
    account: currentAnthropicAccountName(),
    lapsesAtMs,
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  }
}

export type AnthropicWindowFact = {
  status: QuotaStatus
  observedAtMs: number
  owner: string
  resetsAtMs?: number
  claim?: RateLimitType
}

export function anthropicWindowFact(): AnthropicWindowFact | undefined {
  if (!windowObserved || verdictOwner === null || verdictObservedAtMs === null || !verdictOwnerStands()) return undefined
  const resetsAtMs = statedResetMs(currentLimits.resetsAt)
  return {
    status: currentLimits.status,
    observedAtMs: verdictObservedAtMs,
    owner: verdictOwner,
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(currentLimits.rateLimitType !== undefined ? { claim: currentLimits.rateLimitType } : {}),
  }
}

export function adoptAnthropicWindowFact(fact: unknown): boolean {
  if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return false
  const f = fact as Partial<AnthropicWindowFact>
  if (f.status !== 'allowed' && f.status !== 'allowed_warning' && f.status !== 'rejected') return false
  if (typeof f.observedAtMs !== 'number' || !Number.isFinite(f.observedAtMs) || f.observedAtMs <= 0) return false
  if (typeof f.owner !== 'string' || f.owner === '' || f.owner === 'none') return false
  if (f.owner !== resolveOwner()) return false
  if (verdictObservedAtMs !== null && f.observedAtMs <= verdictObservedAtMs) return false
  const resetsAtMs = typeof f.resetsAtMs === 'number' && Number.isFinite(f.resetsAtMs) && f.resetsAtMs > 0 ? f.resetsAtMs : undefined
  const next: ClaudeAILimits = {
    status: f.status,
    unifiedRateLimitFallbackAvailable: false,
    resetsAt: resetsAtMs !== undefined ? resetsAtMs / 1000 : undefined,
    isUsingOverage: false,
  }
  const claim = (fact as { claim?: unknown }).claim
  if (typeof claim === 'string' && claim !== '') next.rateLimitType = claim as RateLimitType
  windowObserved = true
  verdictOwner = f.owner
  verdictObservedAtMs = f.observedAtMs
  logForDebugging(`[limits] window observed · ${next.status} · owner ${verdictOwner} · relayed from the session's runner`)
  if (!limitsEqual(next, currentLimits)) {
    emitStatusChange(next)
  }
  return true
}

function handleGateClosed(): void {
  logForDebugging(`[limits] gate closed · the subscriber gate read false · the window record clears (${windowObserved ? `it was observed · owner ${verdictOwner}` : 'it was unobserved'})`)
  usageCredentialEpoch++
  rawUtilization = {}
  endpointUtilization = {}
  observedOwner = null
  verdictOwner = null
  verdictObservedAtMs = null
  windowObserved = false
  noteUsageRecordChanged()
  if (currentLimits.status !== 'allowed' || currentLimits.resetsAt !== undefined) {
    emitStatusChange({ ...DEFAULT_LIMITS })
  }
}

export function extractQuotaStatusFromHeaders(headers: Headers, startedAtMs: number = Date.now()): void {
  if (!shouldProcessRateLimits(isClaudeAISubscriber())) {
    handleGateClosed()
    return
  }
  if (verdictObservedAtMs !== null && startedAtMs < verdictObservedAtMs) {
    logForDebugging(`[limits] a reply that began at ${new Date(startedAtMs).toISOString()} folds nothing: the standing verdict (${currentLimits.status}) was observed later, at ${new Date(verdictObservedAtMs).toISOString()}`)
    return
  }
  const effective = processRateLimitHeaders(headers)
  recomputeRawUtilization(effective)
  const next = computeNewLimitsFromHeaders(effective)
  windowObserved = true
  stampVerdictOwner(startedAtMs)
  if (!limitsEqual(next, currentLimits)) {
    emitStatusChange(next)
  }
}

export function extractQuotaStatusFromError(error: unknown): void {
  try {
    if (!shouldProcessRateLimits(isClaudeAISubscriber())) return
    if (classifyAnthropicRefusal(anthropicRefusalFactsOf(error)) !== 'window') return
    const headers = (error as { headers?: Headers }).headers
    let next: ClaudeAILimits
    if (headers) {
      const effective = processRateLimitHeaders(headers)
      recomputeRawUtilization(effective)
      next = computeNewLimitsFromHeaders(effective)
    } else {
      next = { ...currentLimits }
    }
    next.status = 'rejected'
    windowObserved = true
    stampVerdictOwner()
    if (!limitsEqual(next, currentLimits)) {
      emitStatusChange(next)
    }
  } catch (err) {
    logError(err)
  }
}


export function __setRawUtilizationForTest(record: RawUtilization): void {
  rawUtilization = record
  noteUsageRecordChanged()
}

export function resetLimitsForCredentialSwitch(): void {
  usageCredentialEpoch++
  rawUtilization = {}
  observedOwner = null
  verdictOwner = null
  verdictObservedAtMs = null
  endpointUtilization = {}
  windowObserved = false
  noteUsageRecordChanged()
  if (!limitsEqual(currentLimits, DEFAULT_LIMITS)) {
    emitStatusChange({ ...DEFAULT_LIMITS })
  }
}

export { getRateLimitErrorMessage, getRateLimitWarning, getUsingOverageText } from './rateLimitMessages.js'
