import { flagEnv } from '../substrate/flagRegistry.js'
import type { RateLimitType } from './anthropicLimits.js'
import { FIRST_WARNING_PCT } from './providers/usageTiers.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


type MockHeaderKey =
  Unbuilt

type MockScenario =
  Unbuilt

type MockHeaders = Unbuilt

type ScenarioPool = { utilization: number; resets_at: string }

type ScenarioPools = Partial<Record<'seven_day_opus' | 'seven_day_sonnet', ScenarioPool>>


let mockHeaders: MockHeaders = unbuilt('src/services/mockRateLimits.ts:28')
let scenarioPools: ScenarioPools = unbuilt('src/services/mockRateLimits.ts:32')

const HEADER_PREFIX: Unbuilt = unbuilt('src/services/mockRateLimits.ts:35')

function isArmed(): boolean {
  return flagEnv('MERCURY_MOCK_LIMITS') !== undefined
}

function nowSeconds(): number {
  return notBuilt('src/services/mockRateLimits.ts:45')
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

export function setMockHeader(key: MockHeaderKey, value: string | undefined): void {
  return notBuilt('src/services/mockRateLimits.ts:99')
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
  return notBuilt('src/services/mockRateLimits.ts:156')
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
  return notBuilt('src/services/mockRateLimits.ts:202')
}

export function setMockRateLimitScenario(scenario: MockScenario): void {
  return notBuilt('src/services/mockRateLimits.ts:216')
}

export function getCurrentMockScenario(): MockScenario | null {
  return notBuilt('src/services/mockRateLimits.ts:307')
}


function titleCaseHeader(key: string): string {
  const stripped = key.replace(HEADER_PREFIX, '')
  return stripped
    .split('-')
    .map(word => (word.length > 0 ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function getMockStatus(): string {
  return notBuilt('src/services/mockRateLimits.ts:337')
}

export function getMockHeaders(): MockHeaders | null {
  return notBuilt('src/services/mockRateLimits.ts:368')
}

export function shouldProcessMockLimits(): boolean {
  return notBuilt('src/services/mockRateLimits.ts:373')
}

export function applyMockHeaders(headers: Headers): Headers {
  return notBuilt('src/services/mockRateLimits.ts:378')
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
