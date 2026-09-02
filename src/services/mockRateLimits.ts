import { flagEnv } from '../substrate/flagRegistry.js'
import { setMockBillingAccessOverride } from '../utils/billing.js'
import type { RateLimitType } from './claudeAiLimits.js'

/**
 * Deterministic rate-limit header fixture engine behind `/mock-limits`.
 * The whole seam is gated on the registered MERCURY_MOCK_LIMITS flag — a
 * live read on every call, never a module-load snapshot. Unset, behaviour
 * is byte-identical to having no mock support at all.
 */

export type MockHeaderKey =
  | 'status'
  | 'reset'
  | 'claim'
  | 'overage-status'
  | 'overage-reset'
  | 'overage-disabled-reason'
  | 'fallback'
  | 'fallback-percentage'
  | 'retry-after'
  | '5h-utilization'
  | '5h-reset'
  | '5h-surpassed-threshold'
  | '7d-utilization'
  | '7d-reset'
  | '7d-surpassed-threshold'

export type MockScenario =
  | 'normal'
  | 'session-limit-reached'
  | 'approaching-weekly-limit'
  | 'weekly-limit-reached'
  | 'overage-active'
  | 'overage-warning'
  | 'overage-exhausted'
  | 'out-of-credits'
  | 'org-zero-credit-limit'
  | 'org-spend-cap-hit'
  | 'member-zero-credit-limit'
  | 'seat-tier-zero-credit-limit'
  | 'opus-limit'
  | 'opus-warning'
  | 'sonnet-limit'
  | 'sonnet-warning'
  | 'extra-usage-required'
  | 'clear'

type MockHeaders = Record<string, string | undefined>

type ExceededLimit = { type: RateLimitType; resetsAt: number }

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

let mockHeaders: MockHeaders = {}
let enabled = false
let headerless429Message: string | null = null
let exceededLimits: ExceededLimit[] = []
// Permanently inert: no mock path can set this.
const mockSubscriptionType: string | null = null

const HEADER_PREFIX = 'anthropic-ratelimit-unified-'

function isArmed(): boolean {
  return flagEnv('MERCURY_MOCK_LIMITS') !== undefined
}

function headerNameFor(key: MockHeaderKey): string {
  return key === 'retry-after' ? 'retry-after' : `${HEADER_PREFIX}${key}`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function hoursFromNowEpoch(hours: number): number {
  return nowSeconds() + Math.round(hours * 3600)
}

// --------------------------------------------------------------------------
// Derivations
// --------------------------------------------------------------------------

/**
 * `retry-after` exists only when status is rejected, overage is absent or
 * rejected, and a reset exists; its value is the whole seconds to that
 * reset.
 */
function deriveRetryAfter(): void {
  const status = mockHeaders[`${HEADER_PREFIX}status`]
  const overage = mockHeaders[`${HEADER_PREFIX}overage-status`]
  const reset = mockHeaders[`${HEADER_PREFIX}reset`]
  if (status === 'rejected' && (overage === undefined || overage === 'rejected') && reset !== undefined) {
    const seconds = Math.max(0, Math.floor(Number(reset) - nowSeconds()))
    mockHeaders['retry-after'] = String(seconds)
  } else {
    delete mockHeaders['retry-after']
  }
}

/** The exceeded entry with the FURTHEST reset supplies claim + reset. */
function deriveRepresentativeClaim(): void {
  if (exceededLimits.length === 0) {
    delete mockHeaders[`${HEADER_PREFIX}representative-claim`]
    delete mockHeaders[`${HEADER_PREFIX}reset`]
    delete mockHeaders['retry-after']
    return
  }
  let furthest = exceededLimits[0] as ExceededLimit
  for (const entry of exceededLimits) {
    if (entry.resetsAt > furthest.resetsAt) furthest = entry
  }
  mockHeaders[`${HEADER_PREFIX}representative-claim`] = furthest.type
  mockHeaders[`${HEADER_PREFIX}reset`] = String(furthest.resetsAt)
  deriveRetryAfter()
}

// --------------------------------------------------------------------------
// Setters
// --------------------------------------------------------------------------

const CLAIM_DERIVED_TYPES = new Set<string>([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
])

export function setMockHeader(key: MockHeaderKey, value: string | undefined): void {
  if (!isArmed()) return
  // Any call — including a delete — marks the engine enabled, and nothing
  // in this entry point ever disables it again.
  enabled = true
  const headerName = headerNameFor(key)
  if (value === undefined || value === 'clear') {
    if (key === 'status' || key === 'overage-status') {
      delete mockHeaders[headerName]
      deriveRetryAfter()
      return
    }
    if (key === 'claim') {
      // Deletes only the inert alias key; a representative-claim header
      // written by the derivation survives.
      delete mockHeaders[headerName]
      exceededLimits = []
      return
    }
    delete mockHeaders[headerName]
    return
  }
  if (key === 'reset' || key === 'overage-reset') {
    const numeric = Number(value)
    mockHeaders[headerName] = Number.isNaN(numeric) ? value : String(hoursFromNowEpoch(numeric))
    return
  }
  if (key === 'claim') {
    if (CLAIM_DERIVED_TYPES.has(value)) {
      const hours = value === 'five_hour' ? 5 : 7 * 24
      exceededLimits = exceededLimits.filter(entry => entry.type !== value)
      exceededLimits.push({ type: value as RateLimitType, resetsAt: hoursFromNowEpoch(hours) })
      deriveRepresentativeClaim()
      return
    }
    // A fable/overage (or unknown) value falls through and is stored under
    // the alias-derived key — which is NOT the representative-claim header
    // and is read by nothing. Reproduced as built.
    mockHeaders[headerName] = value
    return
  }
  mockHeaders[headerName] = value
  if (key === 'status' || key === 'overage-status') {
    deriveRetryAfter()
  }
}

export function addExceededLimit(type: RateLimitType, hoursFromNow: number): void {
  if (!isArmed()) return
  enabled = true
  exceededLimits = exceededLimits.filter(entry => entry.type !== type)
  exceededLimits.push({ type, resetsAt: hoursFromNowEpoch(hoursFromNow) })
  // Status FIRST, so the derivation produces retry-after.
  mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
  deriveRepresentativeClaim()
}

const WARNING_HEADER_KEYS = [
  '5h-utilization',
  '5h-reset',
  '5h-surpassed-threshold',
  '7d-utilization',
  '7d-reset',
  '7d-surpassed-threshold',
] as const

export function setMockEarlyWarning(
  abbrev: '5h' | '7d' | 'overage',
  utilization: number,
  hoursFromNow?: number,
): void {
  if (!isArmed()) return
  enabled = true
  // Clear ALL 5h/7d warning headers first: 5h is evaluated before 7d and
  // stale 5h headers would shadow a 7d test.
  for (const key of WARNING_HEADER_KEYS) {
    delete mockHeaders[`${HEADER_PREFIX}${key}`]
  }
  const hours = hoursFromNow ?? (abbrev === '5h' ? 4 : 5 * 24)
  mockHeaders[`${HEADER_PREFIX}${abbrev}-utilization`] = String(utilization)
  mockHeaders[`${HEADER_PREFIX}${abbrev}-reset`] = String(hoursFromNowEpoch(hours))
  mockHeaders[`${HEADER_PREFIX}${abbrev}-surpassed-threshold`] = String(utilization)
  if (mockHeaders[`${HEADER_PREFIX}status`] === undefined) {
    mockHeaders[`${HEADER_PREFIX}status`] = 'allowed'
  }
}

/** Ungated: it only acts on state that could not exist while disarmed. */
export function clearMockEarlyWarning(): void {
  for (const key of WARNING_HEADER_KEYS) {
    delete mockHeaders[`${HEADER_PREFIX}${key}`]
  }
}

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

/** Midnight local at the start of next month (the monthly billing reset). */
function nextMonthEpoch(): number {
  const now = new Date()
  return Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000)
}

const SCENARIO_DESCRIPTIONS: Record<MockScenario, string> = {
  normal: 'Healthy window, no warnings',
  'session-limit-reached': 'Five-hour session limit exhausted',
  'approaching-weekly-limit': 'Weekly limit early warning',
  'weekly-limit-reached': 'Weekly limit exhausted',
  'overage-active': 'Capped, running on extra usage',
  'overage-warning': 'Extra usage close to its spending cap',
  'overage-exhausted': 'Extra usage exhausted too',
  'out-of-credits': 'Extra usage exhausted: out of credits',
  'org-zero-credit-limit': 'Org service zero-credit limit',
  'org-spend-cap-hit': 'Org spend cap hit (disabled until reset)',
  'member-zero-credit-limit': 'Member zero-credit limit',
  'seat-tier-zero-credit-limit': 'Seat-tier zero-credit limit',
  'opus-limit': 'Opus weekly limit exhausted',
  'opus-warning': 'Opus weekly limit early warning',
  'sonnet-limit': 'Sonnet weekly limit exhausted',
  'sonnet-warning': 'Sonnet weekly limit early warning',
  'extra-usage-required': 'Headerless 429: extra usage required',
  clear: 'Clear mock headers and disable the engine',
}

export function getScenarioDescription(scenario: MockScenario): string {
  return SCENARIO_DESCRIPTIONS[scenario] ?? 'Unknown scenario'
}

function setOverageScenario(overageStatus: 'allowed' | 'allowed_warning' | 'rejected'): void {
  if (exceededLimits.length === 0) {
    exceededLimits.push({ type: 'five_hour', resetsAt: hoursFromNowEpoch(5) })
  }
  deriveRepresentativeClaim()
  mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
  mockHeaders[`${HEADER_PREFIX}overage-status`] = overageStatus
  mockHeaders[`${HEADER_PREFIX}overage-reset`] = String(nextMonthEpoch())
}

export function setMockRateLimitScenario(scenario: MockScenario): void {
  if (!isArmed()) return
  if (scenario === 'clear') {
    // The NARROW clear: exceeded limits survive; only headers, the
    // headerless message and the enabled flag go.
    mockHeaders = {}
    headerless429Message = null
    enabled = false
    return
  }
  enabled = true
  mockHeaders = {}
  headerless429Message = null
  if (scenario !== 'overage-active' && scenario !== 'overage-warning' && scenario !== 'overage-exhausted') {
    exceededLimits = []
  }
  switch (scenario) {
    case 'normal':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(5))
      break
    case 'session-limit-reached':
      exceededLimits.push({ type: 'five_hour', resetsAt: hoursFromNowEpoch(5) })
      // Claim derived BEFORE status: at derivation time the status is not
      // yet rejected, so no scenario ever produces retry-after.
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'approaching-weekly-limit':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed_warning'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(7 * 24))
      mockHeaders[`${HEADER_PREFIX}representative-claim`] = 'seven_day'
      break
    case 'weekly-limit-reached':
      exceededLimits.push({ type: 'seven_day', resetsAt: hoursFromNowEpoch(7 * 24) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'overage-active':
      setOverageScenario('allowed')
      break
    case 'overage-warning':
      setOverageScenario('allowed_warning')
      break
    case 'overage-exhausted':
      setOverageScenario('rejected')
      break
    case 'out-of-credits':
      setOverageScenario('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'out_of_credits'
      break
    case 'org-zero-credit-limit':
      setOverageScenario('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'org_service_zero_credit_limit'
      break
    case 'org-spend-cap-hit':
      setOverageScenario('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'org_level_disabled_until'
      break
    case 'member-zero-credit-limit':
      setOverageScenario('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'member_zero_credit_limit'
      break
    case 'seat-tier-zero-credit-limit':
      setOverageScenario('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'seat_tier_zero_credit_limit'
      break
    case 'opus-limit':
      exceededLimits.push({ type: 'seven_day_opus', resetsAt: hoursFromNowEpoch(7 * 24) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'opus-warning':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed_warning'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(7 * 24))
      mockHeaders[`${HEADER_PREFIX}representative-claim`] = 'seven_day_opus'
      break
    case 'sonnet-limit':
      exceededLimits.push({ type: 'seven_day_sonnet', resetsAt: hoursFromNowEpoch(7 * 24) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'sonnet-warning':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed_warning'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(7 * 24))
      mockHeaders[`${HEADER_PREFIX}representative-claim`] = 'seven_day_sonnet'
      break
    case 'extra-usage-required':
      headerless429Message = 'Extra usage is required for long-context requests'
      break
  }
}

/** E9: which scenario do the current headers describe, or nothing. */
export function getCurrentMockScenario(): MockScenario | null {
  if (!enabled) return null
  const status = mockHeaders[`${HEADER_PREFIX}status`]
  const claim = mockHeaders[`${HEADER_PREFIX}representative-claim`]
  const overage = mockHeaders[`${HEADER_PREFIX}overage-status`]
  if (claim === 'seven_day_opus') {
    return status === 'rejected' ? 'opus-limit' : 'opus-warning'
  }
  if (claim === 'seven_day_sonnet') {
    return status === 'rejected' ? 'sonnet-limit' : 'sonnet-warning'
  }
  if (overage === 'rejected') return 'overage-exhausted'
  if (overage === 'allowed_warning') return 'overage-warning'
  if (overage === 'allowed') return 'overage-active'
  if (status === 'rejected' && claim === 'five_hour') return 'session-limit-reached'
  if (status === 'rejected' && claim === 'seven_day') return 'weekly-limit-reached'
  if (status === 'allowed_warning' && claim === 'seven_day') return 'approaching-weekly-limit'
  if (status === 'allowed') return 'normal'
  return null
}

// --------------------------------------------------------------------------
// Reporting and reads
// --------------------------------------------------------------------------

function titleCaseHeader(key: string): string {
  const stripped = key.replace(HEADER_PREFIX, '')
  return stripped
    .split('-')
    .map(word => (word.length > 0 ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function getMockStatus(): string {
  const activeHeaders = Object.entries(mockHeaders).filter(([, value]) => value !== undefined)
  if (!enabled || (activeHeaders.length === 0 && mockSubscriptionType === null)) {
    return 'No mock rate limits active — real limits are in use'
  }
  const lines: string[] = ['Mock rate limits:']
  lines.push(
    `  Subscription: ${mockSubscriptionType ?? 'max'} ${mockSubscriptionType !== null ? '(explicitly set)' : '(default)'}`,
  )
  for (const [key, value] of activeHeaders) {
    let rendered = value as string
    if (key.includes('reset')) {
      const epoch = Number(value)
      if (!Number.isNaN(epoch)) {
        rendered = `${value} (${new Date(epoch * 1000).toLocaleString()})`
      }
    }
    lines.push(`  ${titleCaseHeader(key)}: ${rendered}`)
  }
  if (exceededLimits.length > 0) {
    lines.push('  Exceeded limits:')
    for (const entry of exceededLimits) {
      lines.push(`    ${entry.type} — resets ${new Date(entry.resetsAt * 1000).toLocaleString()}`)
    }
  }
  return lines.join('\n')
}

export function getMockHeaders(): MockHeaders | null {
  if (!shouldProcessMockLimits()) return null
  return mockHeaders
}

export function getMockHeaderless429Message(): string | null {
  // (The mock engine's stored message is the one source — no env escape
  // hatch exists.)
  if (!isArmed()) return null
  return headerless429Message
}

/**
 * The full clear: everything, including the cross-module billing override
 * the mock-billing setter would otherwise leave behind. Not gated on the
 * arming flag.
 */
export function clearMockHeaders(): void {
  mockHeaders = {}
  exceededLimits = []
  headerless429Message = null
  enabled = false
  setMockBillingAccessOverride(null)
}

/**
 * Armed AND engine enabled. (No headerless-429 env escape
 * hatch exists.)
 */
export function shouldProcessMockLimits(): boolean {
  if (!isArmed()) return false
  return enabled
}

/**
 * E11: the overlay. Identity ONLY while unarmed; once armed a copy is
 * always produced, even with an empty mock map.
 */
export function applyMockHeaders(headers: Headers): Headers {
  if (!shouldProcessMockLimits()) return headers
  const merged = new Headers(headers)
  for (const [key, value] of Object.entries(mockHeaders)) {
    if (value !== undefined) merged.set(key, value)
  }
  return merged
}

// --------------------------------------------------------------------------
// Utilization payload — the subscription usage endpoint's fixture arm
// --------------------------------------------------------------------------

/**
 * The armed fixture payload for the subscription usage endpoint (the
 * /usage panel's per-family weekly buckets ride this JSON): the registered
 * MERCURY_MOCK_USAGE_PAYLOAD, read live under the same MERCURY_MOCK_LIMITS
 * gate as the header seam. Null whenever the seam is folded shut or the
 * JSON does not parse — the live wire answers then.
 */
export function mockUtilizationPayload(): import('./api/usage.js').Utilization | null {
  if (!isArmed()) return null
  const raw = flagEnv('MERCURY_MOCK_USAGE_PAYLOAD')
  if (raw === undefined || raw === '') return null
  try {
    return JSON.parse(raw) as import('./api/usage.js').Utilization
  } catch {
    return null
  }
}

// --------------------------------------------------------------------------
// Permanently inert mock-subscription / billing exports
// --------------------------------------------------------------------------

export function setMockSubscriptionType(type: string | null): void {
  void type
}

/** Called by the auth layer; must always report "no mock". */
export function getMockSubscriptionType(): null {
  return null
}

export function shouldUseMockSubscription(): boolean {
  return false
}

export function setMockBillingAccess(value: boolean | null): void {
  void value
}
