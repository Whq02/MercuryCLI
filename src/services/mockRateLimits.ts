import { flagEnv } from '../substrate/flagRegistry.js'
import type { RateLimitType } from './anthropicLimits.js'
import { FIRST_WARNING_PCT } from './providers/usageTiers.js'

type ExceededLimit = {
  type: RateLimitType
  resetsAt: number
}

type MockHeaderKey =
  | 'status'
  | 'reset'
  | 'claim'
  | 'fallback'
  | 'fallback-percentage'
  | 'retry-after'
  | 'overage-status'
  | 'overage-reset'
  | 'overage-disabled-reason'
  | '5h-utilization'
  | '5h-reset'
  | '5h-surpassed-threshold'
  | '7d-utilization'
  | '7d-reset'
  | '7d-surpassed-threshold'

type MockScenario =
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

type ScenarioPool = { utilization: number; resets_at: string }

type ScenarioPools = Partial<Record<'seven_day_opus' | 'seven_day_sonnet', ScenarioPool>>

const CLAIM_DERIVED_TYPES: ReadonlySet<string> = new Set([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
])

let enabled = false
let mockHeaders: MockHeaders = {}
let exceededLimits: ExceededLimit[] = []
let scenarioPools: ScenarioPools = {}
const subscriptionOverride: string | null = null

const HEADER_PREFIX = 'anthropic-ratelimit-unified-'

function isArmed(): boolean {
  return flagEnv('MERCURY_MOCK_LIMITS') !== undefined
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function hoursFromNowEpoch(hours: number): number {
  return nowSeconds() + Math.round(hours * 3600)
}

function weeklyPool(utilization: number): ScenarioPool {
  return { utilization, resets_at: new Date(hoursFromNowEpoch(7 * 24) * 1000).toISOString() }
}

function foldScenarioPools(): void {
  const { foldUtilizationFromEndpoint } = require('./anthropicLimits.js') as typeof import('./anthropicLimits.js')
  foldUtilizationFromEndpoint(mockUtilizationPayload() ?? {})
}

function fullHeaderKey(key: MockHeaderKey): string {
  return key === 'retry-after' ? 'retry-after' : `${HEADER_PREFIX}${key}`
}

function updateDerivedRetryAfter(): void {
  const status = mockHeaders[`${HEADER_PREFIX}status`]
  const overageStatus = mockHeaders[`${HEADER_PREFIX}overage-status`]
  const reset = mockHeaders[`${HEADER_PREFIX}reset`]
  if (
    status === 'rejected' &&
    (overageStatus === undefined || overageStatus === 'rejected') &&
    reset !== undefined
  ) {
    const waitSeconds = Math.max(0, Math.floor(Number(reset) - nowSeconds()))
    mockHeaders['retry-after'] = String(waitSeconds)
  } else {
    delete mockHeaders['retry-after']
  }
}

function deriveRepresentativeClaim(): void {
  if (exceededLimits.length === 0) {
    delete mockHeaders[`${HEADER_PREFIX}representative-claim`]
    delete mockHeaders[`${HEADER_PREFIX}reset`]
    delete mockHeaders['retry-after']
    return
  }
  let farthest = exceededLimits[0]!
  for (let i = 1; i < exceededLimits.length; i++) {
    const candidate = exceededLimits[i]!
    if (candidate.resetsAt > farthest.resetsAt) {
      farthest = candidate
    }
  }
  mockHeaders[`${HEADER_PREFIX}representative-claim`] = farthest.type
  mockHeaders[`${HEADER_PREFIX}reset`] = String(farthest.resetsAt)
  updateDerivedRetryAfter()
}

export function setMockHeader(key: MockHeaderKey, value: string | undefined): void {
  if (!isArmed()) return
  enabled = true
  const fullKey = fullHeaderKey(key)

  if (value === undefined || value === 'clear') {
    delete mockHeaders[fullKey]
    if (key === 'claim') {
      exceededLimits = []
    }
    if (key === 'status' || key === 'overage-status') {
      updateDerivedRetryAfter()
    }
    return
  }

  if (key === 'reset' || key === 'overage-reset') {
    const hours = Number(value)
    mockHeaders[fullKey] = Number.isNaN(hours) ? value : String(hoursFromNowEpoch(hours))
    return
  }

  if (key === 'claim' && CLAIM_DERIVED_TYPES.has(value)) {
    const limitType = value as RateLimitType
    const resetsAt = hoursFromNowEpoch(limitType === 'five_hour' ? 5 : 7 * 24)
    exceededLimits = exceededLimits.filter(entry => entry.type !== limitType)
    exceededLimits.push({ type: limitType, resetsAt })
    deriveRepresentativeClaim()
    return
  }

  mockHeaders[fullKey] = value
  if (key === 'status' || key === 'overage-status') {
    updateDerivedRetryAfter()
  }
}

const WARNING_HEADER_KEYS = [
  '5h-utilization',
  '5h-reset',
  '5h-surpassed-threshold',
  '7d-utilization',
  '7d-reset',
  '7d-surpassed-threshold',
] as const

export function setMockUsagePercent(abbrev: '5h' | '7d', pct: number): void {
  if (!isArmed() || !Number.isFinite(pct) || pct < 0 || pct > 100) return
  const reset = Number(mockHeaders[`${HEADER_PREFIX}${abbrev}-reset`])
  const now = nowSeconds()
  setMockRateLimitScenario('clear')
  setMockEarlyWarning(abbrev, pct / 100, Number.isFinite(reset) && reset > now ? (reset - now) / 3600 : undefined)
}

export function setMockEarlyWarning(
  abbrev: '5h' | '7d' | 'overage',
  utilization: number,
  hoursFromNow?: number,
): void {
  if (!isArmed()) return
  enabled = true
  for (const key of WARNING_HEADER_KEYS) {
    delete mockHeaders[`${HEADER_PREFIX}${key}`]
  }
  const defaultHours = abbrev === '5h' ? 4 : 5 * 24
  const resetEpoch = hoursFromNowEpoch(hoursFromNow ?? defaultHours)
  const utilizationText = String(utilization)
  mockHeaders[`${HEADER_PREFIX}${abbrev}-utilization`] = utilizationText
  mockHeaders[`${HEADER_PREFIX}${abbrev}-reset`] = String(resetEpoch)
  mockHeaders[`${HEADER_PREFIX}${abbrev}-surpassed-threshold`] = utilizationText
  if (mockHeaders[`${HEADER_PREFIX}status`] === undefined) {
    mockHeaders[`${HEADER_PREFIX}status`] = 'allowed'
  }
}

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
  'opus-warning': 'Opus weekly limit early warning — only an Opus model warns',
  'sonnet-limit': 'Sonnet weekly limit exhausted',
  'sonnet-warning': 'Sonnet weekly limit early warning — only a Sonnet model warns',
  'extra-usage-required': 'Headerless 429: extra usage required',
  clear: 'Clear mock headers and disable the engine',
}

export function getScenarioDescription(scenario: MockScenario): string {
  return SCENARIO_DESCRIPTIONS[scenario] ?? 'Unknown scenario'
}

function applyOverageBranch(overageStatus: 'allowed' | 'allowed_warning' | 'rejected'): void {
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
  const hadPools = Object.keys(scenarioPools).length > 0

  if (scenario === 'clear') {
    mockHeaders = {}
    scenarioPools = {}
    enabled = false
    if (hadPools) foldScenarioPools()
    return
  }

  enabled = true
  mockHeaders = {}
  scenarioPools = {}
  if (
    scenario !== 'overage-active' &&
    scenario !== 'overage-warning' &&
    scenario !== 'overage-exhausted'
  ) {
    exceededLimits = []
  }

  switch (scenario) {
    case 'normal':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(5))
      break
    case 'session-limit-reached':
      exceededLimits.push({ type: 'five_hour', resetsAt: hoursFromNowEpoch(5) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'weekly-limit-reached':
      exceededLimits.push({ type: 'seven_day', resetsAt: hoursFromNowEpoch(7 * 24) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'opus-limit':
      exceededLimits.push({ type: 'seven_day_opus', resetsAt: hoursFromNowEpoch(7 * 24) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'sonnet-limit':
      exceededLimits.push({ type: 'seven_day_sonnet', resetsAt: hoursFromNowEpoch(7 * 24) })
      deriveRepresentativeClaim()
      mockHeaders[`${HEADER_PREFIX}status`] = 'rejected'
      break
    case 'approaching-weekly-limit':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed_warning'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(7 * 24))
      mockHeaders[`${HEADER_PREFIX}representative-claim`] = 'seven_day'
      setMockEarlyWarning('7d', FIRST_WARNING_PCT / 100, 7 * 24)
      break
    case 'overage-active':
      applyOverageBranch('allowed')
      break
    case 'overage-warning':
      applyOverageBranch('allowed_warning')
      break
    case 'overage-exhausted':
      applyOverageBranch('rejected')
      break
    case 'out-of-credits':
      applyOverageBranch('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'out_of_credits'
      break
    case 'org-zero-credit-limit':
      applyOverageBranch('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'org_service_zero_credit_limit'
      break
    case 'org-spend-cap-hit':
      applyOverageBranch('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'org_level_disabled_until'
      break
    case 'member-zero-credit-limit':
      applyOverageBranch('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'member_zero_credit_limit'
      break
    case 'seat-tier-zero-credit-limit':
      applyOverageBranch('rejected')
      mockHeaders[`${HEADER_PREFIX}overage-disabled-reason`] = 'seat_tier_zero_credit_limit'
      break
    case 'opus-warning':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed_warning'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(7 * 24))
      mockHeaders[`${HEADER_PREFIX}representative-claim`] = 'seven_day_opus'
      scenarioPools.seven_day_opus = weeklyPool(FIRST_WARNING_PCT)
      break
    case 'sonnet-warning':
      mockHeaders[`${HEADER_PREFIX}status`] = 'allowed_warning'
      mockHeaders[`${HEADER_PREFIX}reset`] = String(hoursFromNowEpoch(7 * 24))
      mockHeaders[`${HEADER_PREFIX}representative-claim`] = 'seven_day_sonnet'
      scenarioPools.seven_day_sonnet = weeklyPool(FIRST_WARNING_PCT)
      break
    case 'extra-usage-required':
      break
  }

  if (hadPools || Object.keys(scenarioPools).length > 0) {
    foldScenarioPools()
  }
}

export function getCurrentMockScenario(): MockScenario | null {
  if (!enabled) return null
  const status = mockHeaders[`${HEADER_PREFIX}status`]
  const claim = mockHeaders[`${HEADER_PREFIX}representative-claim`]
  const overageStatus = mockHeaders[`${HEADER_PREFIX}overage-status`]

  if (claim === 'seven_day_opus') {
    return status === 'rejected' ? 'opus-limit' : 'opus-warning'
  }
  if (claim === 'seven_day_sonnet') {
    return status === 'rejected' ? 'sonnet-limit' : 'sonnet-warning'
  }
  if (overageStatus === 'rejected') return 'overage-exhausted'
  if (overageStatus === 'allowed_warning') return 'overage-warning'
  if (overageStatus === 'allowed') return 'overage-active'
  if (status === 'rejected' && claim === 'five_hour') return 'session-limit-reached'
  if (status === 'rejected' && claim === 'seven_day') return 'weekly-limit-reached'
  if (status === 'allowed_warning' && claim === 'seven_day') return 'approaching-weekly-limit'
  if (status === 'allowed') return 'normal'
  return null
}

function titleCaseHeader(key: string): string {
  const stripped = key.replace(HEADER_PREFIX, '')
  return stripped
    .split('-')
    .map(word => (word.length > 0 ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function getMockStatus(): string {
  const definedHeaders = Object.entries(mockHeaders).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  if (!enabled || (definedHeaders.length === 0 && subscriptionOverride === null)) {
    return 'No mock rate limits active — real limits are in use'
  }

  const lines: string[] = ['Mock rate limits:']
  lines.push(
    subscriptionOverride !== null
      ? `  Subscription: ${subscriptionOverride} (explicitly set)`
      : '  Subscription: max (default)',
  )

  for (const [key, value] of definedHeaders) {
    const title = titleCaseHeader(key)
    if (key.endsWith('-reset')) {
      const numeric = Number(value)
      if (!Number.isNaN(numeric)) {
        lines.push(`  ${title}: ${value} (${new Date(numeric * 1000).toLocaleString()})`)
        continue
      }
    }
    lines.push(`  ${title}: ${value}`)
  }

  for (const [claim, pool] of Object.entries(scenarioPools)) {
    if (pool === undefined) continue
    lines.push(
      `  Weekly pool ${claim}: ${pool.utilization}% — resets ${new Date(pool.resets_at).toLocaleString()}`,
    )
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
  return shouldProcessMockLimits() ? mockHeaders : null
}

export function shouldProcessMockLimits(): boolean {
  return isArmed() && enabled
}

export function applyMockHeaders(headers: Headers): Headers {
  if (!shouldProcessMockLimits()) return headers
  const copy = new Headers(headers)
  for (const [key, value] of Object.entries(mockHeaders)) {
    if (value !== undefined) {
      copy.set(key, value)
    }
  }
  return copy
}

export function mockUtilizationPayload(): import('./api/usage.js').Utilization | null {
  if (!isArmed()) return null
  const raw = flagEnv('MERCURY_MOCK_USAGE_PAYLOAD')
  let payload: import('./api/usage.js').Utilization | null = null
  if (raw !== undefined && raw !== '') {
    try {
      payload = JSON.parse(raw) as import('./api/usage.js').Utilization
    } catch {
      payload = null
    }
  }
  if (Object.keys(scenarioPools).length === 0) return payload
  return { ...(payload ?? {}), ...scenarioPools }
}
