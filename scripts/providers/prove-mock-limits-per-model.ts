#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'mock-limits-per-model-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_MOCK_LIMITS = '1'
delete process.env.MERCURY_MOCK_USAGE_PAYLOAD
delete process.env.MERCURY_USAGE_SEED
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
const limits = await import('../../src/services/claudeAiLimits.ts')
const armScenario = (scenario: Parameters<typeof mock.setMockRateLimitScenario>[0]): void => {
  mock.setMockRateLimitScenario(scenario)
  limits.extractQuotaStatusFromHeaders(new globalThis.Headers())
}
const tiers = await import('../../src/services/providers/usageTiers.ts')
const usage = await import('../../src/services/providers/providerUsage.ts')
const { rateLimitWindowName } = await import('../../src/services/rateLimitMessages.ts')
const { providerLimitWarningFacts } = await import('../../src/services/providers/limitWarning.ts')
type Reads = Parameters<typeof providerLimitWarningFacts>[0] extends { reads?: infer R } | undefined ? R : never

const RED = 'RED WHERE THE PER-MODEL SCENARIO SPEAKS A HEADER THE WIRE NEVER CARRIES'
const FIRST = tiers.FIRST_WARNING_PCT
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5'
const OTHERS = ['claude-fable-5-1', 'claude-haiku-4-5']
const nowS = Math.floor(Date.now() / 1000)
const weekAhead = nowS + 7 * 24 * 3600
const entry = { id: 'fixture', provider: 'anthropic', kind: 'subscription-oauth', label: 'fixture', custodian: 'anthropic-slots' } as const
const reads = (): Reads => ({
  route: () => 'anthropic',
  activeEntry: () => entry,
  spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  anthropicPlan: () => 'max',
  anthropicLimits: () => limits.currentLimits,
  anthropicWindows: () => ({
    fiveHour: { key: '5h', state: 'live', usedPct: 12, resetsAtMs: weekAhead * 1000 },
    sevenDay: { key: '7d', state: 'live', usedPct: 36, resetsAtMs: weekAhead * 1000 },
  }),
}) as unknown as Reads
const warns = (model: string): ReturnType<typeof providerLimitWarningFacts> => providerLimitWarningFacts({ model, reads: reads() })
const pools = (): string[] => usage.anthropicPoolWindowViews().map(w => `${w.key}=${Math.round(w.usedPct ?? -1)}`)
const grammar = (pct: number, name: string): RegExp => new RegExp(`^Anthropic: ${pct}% of the ${name} used · resets `)
const speaks = (model: string, name: string): boolean => {
  const facts = warns(model)
  return facts !== null && grammar(FIRST, name).test(facts.view.text) && facts.tier === FIRST && facts.pct === FIRST
}

section('§1 the Opus scenario through the seam road: opus-warning speaks the Opus pool, and only to an Opus seat')
const versionBefore = limits.getUsageRecordVersion()
armScenario('opus-warning')
check('the E9 read still names the scenario from its headers', mock.getCurrentMockScenario() === 'opus-warning', j(mock.getCurrentMockScenario()))
const opus = warns(OPUS)
check(`${RED}: an Opus seat reads the Opus pool at the first tier — "… of the Opus limit used"`, opus !== null && grammar(FIRST, 'Opus limit').test(opus.view.text) && opus.windowKey === 'seven_day_opus' && opus.tier === FIRST && opus.pct === FIRST, j(opus))
check(`${RED}: the pool rides the record the strip reads — the live pool view holds the Opus week at the first tier and no other pool`, j(pools()) === j([`seven_day_opus=${FIRST}`]), j(pools()))
check("the record moved at the arming, so the strip re-reads on the record's change signal instead of waiting for a poll", limits.getUsageRecordVersion() > versionBefore, `${versionBefore} → ${limits.getUsageRecordVersion()}`)
check('the Opus pool binds only an Opus model: a Sonnet, a Fable and a Haiku seat read nothing', [SONNET, ...OTHERS].every(m => warns(m) === null), j([SONNET, ...OTHERS].map(m => warns(m)?.view.text ?? null)))
check('the header latch keeps its shape — allowed, the Opus claim, no utilization (a header never states a pool on the real wire)', limits.currentLimits.status === 'allowed' && limits.currentLimits.rateLimitType === 'seven_day_opus' && limits.currentLimits.utilization === undefined, j(limits.currentLimits))
const payloadOpus = mock.mockUtilizationPayload()
check("the mock's usage payload states the armed pool and nothing else in a home with no env payload", payloadOpus !== null && j(Object.keys(payloadOpus)) === j(['seven_day_opus']) && payloadOpus.seven_day_opus?.utilization === FIRST && Date.parse(payloadOpus.seven_day_opus?.resets_at ?? '') / 1000 > nowS, j(payloadOpus))
check('the status names the pool beside the headers', mock.getMockStatus().includes('seven_day_opus') && mock.getMockStatus().includes(`${FIRST}%`), mock.getMockStatus())

section('§2 the Sonnet scenario: sonnet-warning speaks the Sonnet pool, and the Opus pool leaves with its scenario')
armScenario('sonnet-warning')
check('the Sonnet word in this home: no plan word, so the pool is the "Sonnet limit" (a pro or enterprise plan would say "weekly limit")', rateLimitWindowName('seven_day_sonnet') === 'Sonnet limit', rateLimitWindowName('seven_day_sonnet'))
check(`${RED}: a Sonnet seat reads the Sonnet pool at the first tier — "… of the Sonnet limit used"`, speaks(SONNET, 'Sonnet limit'), j(warns(SONNET)))
check('the Opus pool is gone with its scenario: the Opus seat reads nothing and the live pool view holds only the Sonnet week', warns(OPUS) === null && j(pools()) === j([`seven_day_sonnet=${FIRST}`]), j({ opus: warns(OPUS)?.view.text ?? null, pools: pools() }))
check('E9 names the Sonnet scenario', mock.getCurrentMockScenario() === 'sonnet-warning', j(mock.getCurrentMockScenario()))
check('a Fable and a Haiku seat read nothing', OTHERS.every(m => warns(m) === null), j(OTHERS.map(m => warns(m)?.view.text ?? null)))

section('§3 the runner road and the leaving: a direct scenario set speaks too; normal and clear drop the pool')
mock.setMockRateLimitScenario('opus-warning')
check('a direct set on the runner (no header ingestion) lands the pool the same way', speaks(OPUS, 'Opus limit') && j(pools()) === j([`seven_day_opus=${FIRST}`]), j({ opus: warns(OPUS)?.view.text ?? null, pools: pools() }))
armScenario('normal')
check("'normal' leaves the per-model scenario: no pool remains and both seats read nothing", pools().length === 0 && warns(OPUS) === null && warns(SONNET) === null, j({ pools: pools(), opus: warns(OPUS)?.view.text ?? null, sonnet: warns(SONNET)?.view.text ?? null }))
armScenario('opus-warning')
mock.setMockRateLimitScenario('clear')
check("'clear' drops the pool with the headers: nothing remains in the record or the payload", pools().length === 0 && warns(OPUS) === null && mock.mockUtilizationPayload() === null, j({ pools: pools(), payload: mock.mockUtilizationPayload() }))

section('§4 the control: the shared weekly warning still speaks on every seat from the header latch, and states no pool')
armScenario('approaching-weekly-limit')
check('approaching-weekly-limit warns every seat in the weekly words', [OPUS, SONNET, ...OTHERS].every(m => grammar(FIRST, 'weekly limit').test(warns(m)?.view.text ?? '')), j([OPUS, SONNET, ...OTHERS].map(m => warns(m)?.view.text ?? null)))
check('…and states no pool', pools().length === 0, j(pools()))

section('§5 the env payload: byte-identical with no per-model scenario armed; the armed pool lays over it; leaving re-folds it')
const iso = new Date(weekAhead * 1000).toISOString()
const payload = {
  five_hour: { utilization: 36, resets_at: iso },
  seven_day: { utilization: 44, resets_at: iso },
  seven_day_fable: { utilization: 61, resets_at: iso },
}
process.env.MERCURY_MOCK_USAGE_PAYLOAD = j(payload)
armScenario('normal')
check('with no per-model scenario armed the mock payload is the env payload, byte for byte', j(mock.mockUtilizationPayload()) === j(payload), j(mock.mockUtilizationPayload()))
armScenario('opus-warning')
const overlaid = mock.mockUtilizationPayload()
check("a per-model scenario lays its pool over the env payload and keeps every window the payload states", overlaid?.five_hour?.utilization === 36 && overlaid?.seven_day?.utilization === 44 && overlaid?.seven_day_fable?.utilization === 61 && overlaid?.seven_day_opus?.utilization === FIRST, j(overlaid))
const raw = limits.getRawUtilization()
check("the record carries the payload's windows and pools beside the scenario's pool: 7d 44 · Fable 61 · Opus at the first tier", Math.round((raw.seven_day?.utilization ?? 0) * 100) === 44 && j(pools()) === j(['seven_day_fable=61', `seven_day_opus=${FIRST}`]), j({ sevenDay: raw.seven_day, pools: pools() }))
check('the Fable seat reads nothing on the Opus scenario (its own pool sits under the tier; the Opus pool is not its own)', warns('claude-fable-5-1') === null && speaks(OPUS, 'Opus limit'), j({ fable: warns('claude-fable-5-1')?.view.text ?? null, opus: warns(OPUS)?.view.text ?? null }))
armScenario('normal')
const rawAfter = limits.getRawUtilization()
check("leaving the per-model scenario re-folds the env payload: the Opus pool is gone, the payload's windows and Fable pool stand, the payload is the env's again", j(pools()) === j(['seven_day_fable=61']) && Math.round((rawAfter.seven_day?.utilization ?? 0) * 100) === 44 && j(mock.mockUtilizationPayload()) === j(payload), j({ pools: pools(), sevenDay: rawAfter.seven_day }))
delete process.env.MERCURY_MOCK_USAGE_PAYLOAD
mock.setMockRateLimitScenario('clear')

section('§6 the source: the arms state their pool at the tier owner\'s number; the fold is a lazy require; the list says whose seat warns')
const src = readFileSync(join(ROOT, 'src/services/mockRateLimits.ts'), 'utf8')
const opusArm = src.slice(src.indexOf("case 'opus-warning':"), src.indexOf("case 'sonnet-limit':"))
const sonnetArm = src.slice(src.indexOf("case 'sonnet-warning':"), src.indexOf("case 'extra-usage-required':"))
const flat = (s: string): string => s.trim().split('\n').map(l => l.trim()).join(' | ')
check(`${RED}: the opus-warning arm states the Opus pool at FIRST_WARNING_PCT, never a literal`, /seven_day_opus/.test(opusArm) && /FIRST_WARNING_PCT/.test(opusArm) && !/0\.8|\b80\b/.test(opusArm), flat(opusArm))
check(`${RED}: the sonnet-warning arm states the Sonnet pool at FIRST_WARNING_PCT, never a literal`, /seven_day_sonnet/.test(sonnetArm) && /FIRST_WARNING_PCT/.test(sonnetArm) && !/0\.8|\b80\b/.test(sonnetArm), flat(sonnetArm))
check('both arms keep their headers, so the E9 read and the header latch stand', /representative-claim`\] = 'seven_day_opus'/.test(opusArm) && /representative-claim`\] = 'seven_day_sonnet'/.test(sonnetArm) && /allowed_warning/.test(opusArm) && /allowed_warning/.test(sonnetArm))
check('the fold rides a lazy require of claudeAiLimits: no value import closes the cycle claudeAiLimits → rateLimitMocking → mockRateLimits', !/^import \{[^}]*\} from '\.\/claudeAiLimits\.js'/m.test(src) && /require\('\.\/claudeAiLimits\.js'\)/.test(src) && /^import type \{ RateLimitType \} from '\.\/claudeAiLimits\.js'/m.test(src))
check('the two per-model descriptions say whose seat warns', /only an Opus model warns/.test(mock.getScenarioDescription('opus-warning')) && /only a Sonnet model warns/.test(mock.getScenarioDescription('sonnet-warning')), j([mock.getScenarioDescription('opus-warning'), mock.getScenarioDescription('sonnet-warning')]))

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} the per-model warning scenarios speak: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
