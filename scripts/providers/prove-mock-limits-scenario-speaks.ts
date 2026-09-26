#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'mock-limits-scenario-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_MOCK_LIMITS = '1'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_MODEL

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const mock = await import('../../src/services/mockRateLimits.ts')
const mockCommand = await import('../../src/commands/mock-limits/mock-limits.ts')
const limits = await import('../../src/services/claudeAiLimits.ts')
const tiers = await import('../../src/services/providers/usageTiers.ts')
const { observedFamilyWindow, decideCapAction } = await import('../../src/services/capFailover.ts')
const { providerLimitWarningFacts } = await import('../../src/services/providers/limitWarning.ts')
type Reads = Parameters<typeof providerLimitWarningFacts>[0] extends { reads?: infer R } | undefined ? R : never

const SCENARIO = 'approaching-weekly-limit'
const RED = 'RED WHERE THE SCENARIO SETS A BARE LATCH THE DECODER DEMOTES'
const weekAhead = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
const entry = { id: 'fixture', provider: 'anthropic', kind: 'subscription-oauth', label: 'fixture', custodian: 'anthropic-slots' } as const
const quietReads = (): Reads => ({
  route: () => 'anthropic',
  activeEntry: () => entry,
  spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  anthropicPlan: () => 'max',
  anthropicLimits: () => limits.currentLimits,
  anthropicWindows: () => ({
    fiveHour: { key: '5h', state: 'live', usedPct: 12, resetsAtMs: weekAhead * 1000 },
    sevenDay: { key: '7d', state: 'live', usedPct: 36, resetsAtMs: weekAhead * 1000 },
  }),
  anthropicPoolWindows: () => [],
}) as unknown as Reads

section('§1 the command road: /mock-limits approaching-weekly-limit through the real ingestion')
const result = await mockCommand.call(SCENARIO)
check('the command accepts the scenario and describes it', result.type === 'text' && result.value.includes(`Mock rate-limit scenario: ${SCENARIO}`) && result.value.includes(mock.getScenarioDescription(SCENARIO)), result.type === 'text' ? result.value.split('\n')[0] : result.type)
check('the E9 read still names the scenario from its headers', mock.getCurrentMockScenario() === SCENARIO, j(mock.getCurrentMockScenario()))
const headers = mock.getMockHeaders() ?? {}
check(`${RED}: the scenario speaks the 7d utilization at the first tier, the percent the tiers speak at`, Number(headers['anthropic-ratelimit-unified-7d-utilization']) * 100 === tiers.FIRST_WARNING_PCT && Number(headers['anthropic-ratelimit-unified-7d-reset']) > Math.floor(Date.now() / 1000), j(headers))
const latch = limits.currentLimits
check(`${RED}: the decoder keeps the latch — allowed_warning on the weekly window with its utilization`, latch.status === 'allowed_warning' && latch.rateLimitType === 'seven_day' && latch.utilization !== undefined && Math.round(latch.utilization * 100) === tiers.FIRST_WARNING_PCT, j(latch))
check('the tier owner reads the first tier off it', tiers.usageWarningTier((latch.utilization ?? 0) * 100) === tiers.FIRST_WARNING_PCT && tiers.usageWindowState((latch.utilization ?? 0) * 100) === 'warning', j({ utilization: latch.utilization }))

section('§2 the tier owner\'s road: the resolver, the strip and the card read the scenario as the first warning')
const fact = observedFamilyWindow('anthropic', { now: Date.now, anthropicWindows: () => [], anthropicPools: () => [] }, { model: 'fable' })
check(`${RED}: the resolver reads 'warning' at the first tier on the weekly limit`, fact.state === 'warning' && fact.warningTier === tiers.FIRST_WARNING_PCT && fact.usedPct === tiers.FIRST_WARNING_PCT && fact.windowName === limits.getRateLimitDisplayName('seven_day'), j(fact))
check('a warning never offers a handoff, on any posture', (['off', 'offer', 'auto'] as const).every(p => decideCapAction(p, fact.state).kind === 'none'))
const facts = providerLimitWarningFacts({ model: 'fable', reads: quietReads() })
check(`${RED}: the strip warns in the one grammar at the first tier, the header's percent beating the quiet meters`, facts !== null && facts.tier === tiers.FIRST_WARNING_PCT && facts.pct === tiers.FIRST_WARNING_PCT && new RegExp(`^Anthropic: ${tiers.FIRST_WARNING_PCT}% of the weekly limit used · resets `).test(facts.view.text), j(facts))

section('§3 the controls: the other scenarios and the alias keep their shapes')
mock.setMockRateLimitScenario('normal')
limits.extractQuotaStatusFromHeaders(new globalThis.Headers())
check("'normal' reads allowed with no utilization", limits.currentLimits.status === 'allowed' && limits.currentLimits.utilization === undefined, j(limits.currentLimits))
mock.setMockRateLimitScenario('weekly-limit-reached')
limits.extractQuotaStatusFromHeaders(new globalThis.Headers())
check("'weekly-limit-reached' still reads rejected on the weekly window", limits.currentLimits.status === 'rejected' && limits.currentLimits.rateLimitType === 'seven_day', j(limits.currentLimits))
const alias = await mockCommand.call(`warning-7d ${tiers.SECOND_WARNING_PCT}`)
check('the warning-7d alias still speaks the second tier through the same setter', alias.type === 'text' && limits.currentLimits.status === 'allowed_warning' && Math.round((limits.currentLimits.utilization ?? 0) * 100) === tiers.SECOND_WARNING_PCT, j(limits.currentLimits))
await mockCommand.call(SCENARIO)
check('the scenario re-arms after the alias, byte for byte the first tier again', limits.currentLimits.status === 'allowed_warning' && Math.round((limits.currentLimits.utilization ?? 0) * 100) === tiers.FIRST_WARNING_PCT && mock.getCurrentMockScenario() === SCENARIO, j(limits.currentLimits))
mock.setMockRateLimitScenario('clear')
check('clear disarms', mock.getMockHeaders() === null || mock.shouldProcessMockLimits() === false)

section('§4 the source: the scenario speaks through the early-warning setter at the tier owner\'s number')
const src = readFileSync(join(ROOT, 'src/services/mockRateLimits.ts'), 'utf8')
const arm = src.slice(src.indexOf(`case '${SCENARIO}':`), src.indexOf("case 'weekly-limit-reached':"))
check(`${RED}: the scenario's arm calls the early-warning setter for the 7d window at FIRST_WARNING_PCT`, /setMockEarlyWarning\('7d', FIRST_WARNING_PCT \/ 100, 7 \* 24\)/.test(arm), arm.trim().split('\n').map(l => l.trim()).join(' | '))
check('the number is the tier owner\'s, imported, never a literal of the mock\'s own', /import \{ FIRST_WARNING_PCT \} from '\.\/providers\/usageTiers\.js'/.test(src) && !/0\.8|\b80\b/.test(arm))
check('the description still says what it shows', mock.getScenarioDescription(SCENARIO) === 'Weekly limit early warning')

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} the mock scenario speaks: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
