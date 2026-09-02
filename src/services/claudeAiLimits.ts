import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { getModelBetas } from '../utils/betas.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import { getAnthropicClient } from './api/client.js'
import { getAPIMetadata } from './providers/anthropic/index.js'
import { APIError } from './api/sdkErrors.js'
import { processRateLimitHeaders, shouldProcessRateLimits } from './rateLimitMocking.js'

/**
 * The rate-limit/quota state machine: parses response headers into a
 * limits record, emits change events, and exposes raw per-window
 * utilization. The pure header→limits computation is exported separately
 * so deterministic fixture journeys can run with no module state.
 */

// WIRE SPELLINGS: the two unions below mirror the values Anthropic's
// anthropic-ratelimit-unified-* response headers carry (representative-claim
// and overage-disabled-reason). Plumbing — byte-identical to the wire, never
// shown raw to the operator (rateLimitMessages owns the operator frame).
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

/**
 * The live singleton — a MUTABLE exported binding: a consumer reads
 * `currentLimits.status` directly and a prover pins that consumption.
 */
export let currentLimits: ClaudeAILimits = { ...DEFAULT_LIMITS }

export const statusListeners: Set<(limits: ClaudeAILimits) => void> = new Set()

/** Replace the singleton, then notify every listener in insertion order. */
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

//
// Raw per-window utilization
//

type RawWindow = { utilization: number; resets_at: number }
/** The per-model weekly POOLS the subscription usage endpoint states beside
 *  the shared 5h/7d windows (claude.ai meters them as separate pools). The
 *  response headers never state them, so they are ENDPOINT-FED ONLY — and
 *  they ride the same record, so the strip warning and the /usage meters
 *  read one observation. */
export type WeeklyPoolClaim = 'seven_day_fable' | 'seven_day_opus' | 'seven_day_sonnet'
export const WEEKLY_POOL_CLAIMS: readonly WeeklyPoolClaim[] = ['seven_day_fable', 'seven_day_opus', 'seven_day_sonnet']
type RawUtilization = { five_hour?: RawWindow; seven_day?: RawWindow } & Partial<Record<WeeklyPoolClaim, RawWindow>>

let rawUtilization: RawUtilization = {}

// ── The window records' OWNER (the slot-attribution law, REPLDUP 2b) ────────
//  A window record is a fact about ONE anthropic credential slot: keyed any
//  coarser it outlives the slot that observed it, and a slot flip repaints
//  the DEPARTED account's meters until some reset happens to run (the
//  operator's s-flip sighting; credentialIdentity.ts names the class). Every
//  fold stamps the ACTIVE slot's wallet-entry id; the one read answers only
//  while the stamp still names the active slot — stale-by-construction,
//  with the credential-switch resets kept as the belt.
let observedOwner: string | null = null

/** The active anthropic slot's identity (wallet-entry id; 'none' when no
 *  slot is signed in). Lazy require: the wallet reaches slot custodians
 *  whose neighbors require THIS module lazily (the slotSwitch precedent) —
 *  a top-level import would close that cycle. TTL-cached off the paint
 *  path; the credential epoch (bumped by every reset road) invalidates. */
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
    owner = activeWalletEntry('anthropic')?.id ?? 'none'
  } catch {
    /* a paint read must never throw — an unresolvable wallet reads as none */
  }
  ownerCache = { owner, atMs: at, epoch: usageCredentialEpoch }
  return owner
}

/** Proof seam: pin the owner the folds stamp / the reads compare. */
let ownerOverrideForTest: (() => string) | null = null
export function __setAnthropicOwnerResolverForTest(resolver: (() => string) | null): void {
  ownerOverrideForTest = resolver
  ownerCache = null
}
function resolveOwner(): string {
  return ownerOverrideForTest !== null ? ownerOverrideForTest() : currentAnthropicOwner()
}

/**
 * A window is stored ONLY when both headers are present, non-empty, finite
 * and non-negative — never a fabricated 0 %. The consumer renders a
 * missing window as "unavailable".
 */
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
    next[key] = { utilization, resets_at: resetsAt }
  }
  rawUtilization = next
  // The response rode the ACTIVE slot's credential — stamp the owner.
  observedOwner = resolveOwner()
}

// Seeded windows expire this far from now when the entry names no reset.
const SEED_DEFAULT_TTL_SECONDS = 2820

// ── The /api/oauth/usage feeder (usage-truth lane) ──────────────────────────
//  The subscription usage ENDPOINT states the same 5h/7d windows the
//  response headers do — but the header record is empty until the first API
//  reply, so a fresh signed-in session's meter surfaces (rail · deck ·
//  frame) said "fills after first reply" while the settings tab's own fetch
//  painted live meters: two decoders of one truth. Every fetchUtilization
//  observation now folds HERE (a second FEEDER of the one record, never a
//  second owner); the read overlays it under the header record exactly like
//  the render seed — live headers win per window, the endpoint fills
//  absence, nothing is ever fabricated.
let endpointUtilization: RawUtilization = {}

/** One endpoint window (utilization 0–100 · resets_at ISO) → the raw record
 *  shape (fraction 0–1 · epoch seconds), or null for an unusable entry —
 *  absent/partial/non-finite facts stay absent, never a fabricated 0%. */
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

/**
 * Fold one OBSERVED `/api/oauth/usage` response into the endpoint record —
 * rebuilt wholesale per observation (the header recompute's own law), so a
 * window the endpoint stopped stating cannot linger. Callers pass only a
 * real wire response; "could not fetch" is not an observation.
 */
export function foldUtilizationFromEndpoint(
  u: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null
    seven_day?: { utilization: number | null; resets_at: string | null } | null
  } & Partial<Record<WeeklyPoolClaim, { utilization: number | null; resets_at: string | null } | null>>,
  issuedEpoch?: number,
): void {
  // Stale-by-credential refusal: an observation issued under a departed
  // credential epoch folds nowhere (lane IV — the in-flight answer used to
  // repopulate the feeders a sign-out/switch had just emptied). The guard
  // lives HERE so every caller inherits it.
  if (issuedEpoch !== undefined && issuedEpoch !== usageCredentialEpoch) return
  const next: RawUtilization = {}
  const fiveHour = normalizeEndpointWindow(u.five_hour)
  const sevenDay = normalizeEndpointWindow(u.seven_day)
  if (fiveHour) next.five_hour = fiveHour
  if (sevenDay) next.seven_day = sevenDay
  // The per-model pools land with the windows — the same observation, the
  // same record; a pool the endpoint did not state stays absent.
  for (const claim of WEEKLY_POOL_CLAIMS) {
    const pool = normalizeEndpointWindow(u[claim])
    if (pool) next[claim] = pool
  }
  endpointUtilization = next
  // The endpoint answered under the ACTIVE slot's sign-in — stamp the owner.
  observedOwner = resolveOwner()
}

/**
 * The render/dev seed (MERCURY_USAGE_SEED via the registry's bounded
 * reader): fills only windows ABSENT from live data, never overwrites.
 * With no seed and no endpoint record, the live record object itself is
 * returned (the hot-path zero-copy read).
 */
export function getRawUtilization(): RawUtilization {
  // The slot-attribution gate: records observed under a DEPARTED slot are
  // invisible — the meters read honest absence until the active slot's own
  // traffic or endpoint answer lands (never the old account's numbers).
  // A never-stamped record (nothing observed) passes vacuously.
  const ownerStands = observedOwner === null || observedOwner === resolveOwner()
  const live = ownerStands ? rawUtilization : {}
  const endpoint = ownerStands ? endpointUtilization : {}
  const seed = flagEnv('MERCURY_USAGE_SEED')
  if (seed === undefined && Object.keys(endpoint).length === 0) {
    return live
  }
  const copy: RawUtilization = { ...live }
  // Endpoint observations fill absent windows under the live header record
  // (headers are per-response truth and always win where present).
  if (copy.five_hour === undefined && endpoint.five_hour !== undefined) copy.five_hour = endpoint.five_hour
  if (copy.seven_day === undefined && endpoint.seven_day !== undefined) copy.seven_day = endpoint.seven_day
  // The per-model pools have one feeder (the endpoint) — they ride verbatim.
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
    }
  }
  return copy
}

//
// Pure header → limits computation
//

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  return value === null ? undefined : value
}

type EarlyWarning = ClaudeAILimits

// Time-relative fallback configurations, in evaluation order.
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

/** C6: early-warning detection, header-based first, in strict order. */
function detectEarlyWarning(headers: Headers, fallbackAvailable: boolean): EarlyWarning | null {
  // Header-based: presence of the surpassed-threshold header (any value,
  // empty included) fires; the fixed order decides ties.
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
  // Time-relative fallback: a configuration is skipped only when a header
  // is ABSENT (present-but-empty evaluates as 0 and can never fire).
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

/**
 * C5: the pure computation — no module state, no emission, no gate. The
 * record's KEY SET is load-bearing: the emit gate is a key-sensitive deep
 * equality, so which keys exist (even holding undefined) decides emission.
 */
export function computeNewLimitsFromHeaders(headers: Headers): ClaudeAILimits {
  const statusRaw = headerValue(headers, 'anthropic-ratelimit-unified-status')
  // Unknown strings flow through untouched at runtime; the type narrows.
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
  // Asymmetry, reproduced: overageResetsAt joins only when TRUTHY (a 0 is
  // dropped), while resetsAt of 0 stays as an always-present key.
  const overageResetsAt =
    overageResetRaw !== undefined && overageResetRaw !== '' ? Number(overageResetRaw) : undefined
  if (overageResetsAt) record.overageResetsAt = overageResetsAt
  return record
}

/** Key-sensitive deep equality: a key holding undefined ≠ a missing key. */
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

//
// Live ingestion
//

/** The credential epoch: bumped whenever the account behind the session
 *  changes (sign-out, slot removal, a DIFFERENT account signing in) or the
 *  subscriber gate closes. An in-flight `/api/oauth/usage` observation
 *  belongs to the epoch it was ISSUED under — the fetch seam captures this
 *  before its await and refuses to fold a stale response, so a sign-out
 *  landing inside the fetch window can never be repainted by the departed
 *  account's answer (lane IV: the zombie-usage race). */
let usageCredentialEpoch = 0

export function getUsageCredentialEpoch(): number {
  return usageCredentialEpoch
}

/** C8: on a false gate, clear the raw record and settle to the default.
 *  The endpoint feeder empties with it — a session the gate says is not a
 *  subscriber must not keep painting subscription windows from an earlier
 *  endpoint observation (the same law the header record follows). */
function handleGateClosed(): void {
  usageCredentialEpoch++
  rawUtilization = {}
  endpointUtilization = {}
  observedOwner = null
  if (currentLimits.status !== 'allowed' || currentLimits.resetsAt !== undefined) {
    emitStatusChange({ ...DEFAULT_LIMITS })
  }
}

/** C9: the live header path. */
export function extractQuotaStatusFromHeaders(headers: Headers): void {
  if (!shouldProcessRateLimits(isClaudeAISubscriber())) {
    handleGateClosed()
    return
  }
  const effective = processRateLimitHeaders(headers)
  recomputeRawUtilization(effective)
  const next = computeNewLimitsFromHeaders(effective)
  if (!limitsEqual(next, currentLimits)) {
    emitStatusChange(next)
  }
}

/** the error path — 429 only; forces rejected; never throws. */
export function extractQuotaStatusFromError(error: unknown): void {
  try {
    if (!shouldProcessRateLimits(isClaudeAISubscriber())) return
    const status = (error as { status?: unknown }).status
    if (status !== 429) return
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
    if (!limitsEqual(next, currentLimits)) {
      emitStatusChange(next)
    }
  } catch (err) {
    logError(err)
  }
}

//
// Proactive probe and credential switch
//

/**
 * a minimal request purely to learn the quota. Skipped when privacy
 * disallows non-essential traffic, the gate is closed, or the session is
 * non-interactive (the real request follows immediately there anyway).
 */
export async function checkQuotaStatus(): Promise<void> {
  try {
    if (isEssentialTrafficOnly()) return
    if (!shouldProcessRateLimits(isClaudeAISubscriber())) return
    if (getIsNonInteractiveSession()) return
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    const client = await getAnthropicClient({ maxRetries: 0, source: 'quota_check' })
    const { response } = await client.beta.messages
      .create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
        metadata: getAPIMetadata(),
        ...(betas.length > 0 ? { betas } : {}),
      })
      .withResponse()
    extractQuotaStatusFromHeaders(response.headers)
  } catch (err) {
    if (err instanceof APIError) {
      extractQuotaStatusFromError(err)
      return
    }
    logForDebugging(`checkQuotaStatus: probe achieved nothing: ${String(err)}`)
  }
}

/** Proof seam: place a header-record window directly (the live writer sits
 *  behind the subscriber/mock gate, and the overlay precedence — headers
 *  win where present — must be provable without arming either). */
export function __setRawUtilizationForTest(record: RawUtilization): void {
  rawUtilization = record
}

/**
 * the account behind the session changed — a latched window state
 * (including a "rejected, resets at …" banner) must not outlive it.
 */
export function resetLimitsForCredentialSwitch(): void {
  usageCredentialEpoch++
  rawUtilization = {}
  observedOwner = null
  // The endpoint-observed windows belong to the departed account too — a
  // sign-out/switch empties every window feeder together (the one-truth
  // law: no surface may keep painting the old account's meters).
  endpointUtilization = {}
  if (!limitsEqual(currentLimits, DEFAULT_LIMITS)) {
    emitStatusChange({ ...DEFAULT_LIMITS })
  }
}

// Compatibility surface: several callers reach the messaging accessors
// through this module.
export { getRateLimitErrorMessage, getRateLimitWarning, getUsingOverageText } from './rateLimitMessages.js'
