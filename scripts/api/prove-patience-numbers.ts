#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'patience-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_API_TIMEOUT_MS
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
delete process.env.NODE_ENV

const patience = await import('../../src/services/providers/patience.js')
const idle = await import('../../src/services/providers/streamIdleBudget.js')
const budget = await import('../../src/services/api/recoveryBudget.js')
const settings = await import('../../src/utils/settings/settings.js')
const settingsCache = await import('../../src/utils/settings/settingsCache.js')
const { SettingsSchema } = await import('../../src/utils/settings/types.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function setPatience(value: unknown): void {
  const { error } = settings.updateSettingsForSource('userSettings', { patience: value } as never)
  if (error !== null) throw error
  settingsCache.resetSettingsCache()
}

const FED_ROADS = ['anthropic', 'zai', 'openai-compat'] as const
const QUIET_ROADS = ['openai'] as const
const OWN_ROADS = ['moonshot', 'deepseek', 'openrouter', 'gemini', 'huggingface', 'local', 'unrecognised', null] as const
const everyRoad = (roads: ReadonlyArray<string | null>, ms: number): boolean => roads.every(road => idle.streamIdleTimeoutMsForRoute(road) === ms)
const roadsRead = (roads: ReadonlyArray<string | null>): string => roads.map(road => `${road}=${idle.streamIdleTimeoutMsForRoute(road)}`).join(' ')

section('P1 — the modes: normal, patient, custom; junk reads as normal')
{
  const normal = patience.patienceOf(undefined)
  check('unset ⇒ normal: 90 s idle, 15 min on the quiet road, a 15 min fallback ceiling, a 20 min retry budget', normal.mode === 'normal' && normal.numbers.streamIdleMs === 90_000 && normal.numbers.quietStreamIdleMs === 900_000 && normal.numbers.fallbackCeilingMs === 900_000 && normal.numbers.recoveryBudgetMinutes === 20, JSON.stringify(normal))
  check('"normal" spells the same numbers', JSON.stringify(patience.patienceOf('normal')) === JSON.stringify(normal))
  const patient = patience.patienceOf('patient')
  check('patient ⇒ every wait doubled', patient.mode === 'patient' && patient.numbers.streamIdleMs === 180_000 && patient.numbers.quietStreamIdleMs === 1_800_000 && patient.numbers.fallbackCeilingMs === 1_800_000 && patient.numbers.recoveryBudgetMinutes === 40, JSON.stringify(patient))
  const custom = patience.patienceOf({ streamIdleSeconds: 45, quietStreamIdleSeconds: 600, fallbackCeilingSeconds: 1200, recoveryBudgetMinutes: 3 })
  check('custom ⇒ the numbers, seconds and minutes as the file spells them', custom.mode === 'custom' && custom.numbers.streamIdleMs === 45_000 && custom.numbers.quietStreamIdleMs === 600_000 && custom.numbers.fallbackCeilingMs === 1_200_000 && custom.numbers.recoveryBudgetMinutes === 3, JSON.stringify(custom))
  const partial = patience.patienceOf({ recoveryBudgetMinutes: 0 })
  check('a custom budget of 0 is the budget off; the missing numbers take normal\'s', partial.mode === 'custom' && partial.numbers.recoveryBudgetMinutes === 0 && partial.numbers.streamIdleMs === 90_000 && partial.numbers.quietStreamIdleMs === 900_000 && partial.numbers.fallbackCeilingMs === 900_000, JSON.stringify(partial))
  const malformed = patience.patienceOf({ streamIdleSeconds: 'soon', quietStreamIdleSeconds: -4, fallbackCeilingSeconds: Number.NaN, recoveryBudgetMinutes: -1 })
  check('malformed custom numbers take normal\'s, each on its own', malformed.mode === 'custom' && JSON.stringify(malformed.numbers) === JSON.stringify(normal.numbers), JSON.stringify(malformed))
  check('a custom idle number under the watchdog\'s floor takes normal\'s', patience.patienceOf({ streamIdleSeconds: 0.2 }).numbers.streamIdleMs === 90_000)
  check('junk reads as normal', patience.patienceOf('eager').mode === 'normal' && patience.patienceOf(42).mode === 'normal' && patience.patienceOf([1]).mode === 'normal' && patience.patienceOf(null).mode === 'normal')
}

section('P2 — per road, through the real settings pipeline')
{
  check('unset: the fed roads read 90 s', everyRoad(FED_ROADS, 90_000), roadsRead(FED_ROADS))
  check('unset: the openai road reads the quiet number, 15 min', everyRoad(QUIET_ROADS, 900_000), roadsRead(QUIET_ROADS))
  check('unset: a road with no number of its own reads the shared 90 s', everyRoad(OWN_ROADS, 90_000), roadsRead(OWN_ROADS))
  check('the caller with no road reads the shared 90 s', idle.streamIdleTimeoutMs() === 90_000)
  setPatience('patient')
  check('patient: the fed roads read 3 min', everyRoad(FED_ROADS, 180_000), roadsRead(FED_ROADS))
  check('patient: the openai road reads 30 min', everyRoad(QUIET_ROADS, 1_800_000), roadsRead(QUIET_ROADS))
  check('patient: a road with no number of its own still reads the shared 90 s', everyRoad(OWN_ROADS, 90_000), roadsRead(OWN_ROADS))
  check('patient: the caller with no road still reads the shared 90 s', idle.streamIdleTimeoutMs() === 90_000)
  setPatience({ streamIdleSeconds: 45, quietStreamIdleSeconds: 600, fallbackCeilingSeconds: 1200, recoveryBudgetMinutes: 3 })
  check('custom: the fed roads read the custom idle number', everyRoad(FED_ROADS, 45_000), roadsRead(FED_ROADS))
  check('custom: the openai road reads the custom quiet number', everyRoad(QUIET_ROADS, 600_000), roadsRead(QUIET_ROADS))
  check('custom: a road with no number of its own reads the shared 90 s', everyRoad(OWN_ROADS, 90_000), roadsRead(OWN_ROADS))
  check('the current patience reads the file', patience.currentPatience().mode === 'custom' && patience.currentPatience().numbers.streamIdleMs === 45_000)
  setPatience(undefined)
  check('the key removed: normal again', patience.currentPatience().mode === 'normal' && everyRoad(FED_ROADS, 90_000) && everyRoad(QUIET_ROADS, 900_000))
}

section('P3 — the fallback ceiling and the retry budget follow the mode')
{
  check('normal: the fallback ceiling is 15 min', patience.nonstreamingFallbackCeilingMs() === 900_000, String(patience.nonstreamingFallbackCeilingMs()))
  check('normal: the retry budget is 20 min', budget.recoveryBudgetMs() === 1_200_000 && budget.RECOVERY_BUDGET_DEFAULT_MINUTES === 20, String(budget.recoveryBudgetMs()))
  check('the budget holds the ceiling whole: a reserved fallback is never cut by the budget alone', budget.recoveryBudgetMs() > patience.nonstreamingFallbackCeilingMs())
  setPatience('patient')
  check('patient: the fallback ceiling is 30 min', patience.nonstreamingFallbackCeilingMs() === 1_800_000, String(patience.nonstreamingFallbackCeilingMs()))
  check('patient: the retry budget is 40 min', budget.recoveryBudgetMs() === 2_400_000, String(budget.recoveryBudgetMs()))
  setPatience({ fallbackCeilingSeconds: 1200, recoveryBudgetMinutes: 3 })
  check('custom: the fallback ceiling is the custom number', patience.nonstreamingFallbackCeilingMs() === 1_200_000, String(patience.nonstreamingFallbackCeilingMs()))
  check('custom: the retry budget is the custom number', budget.recoveryBudgetMs() === 180_000, String(budget.recoveryBudgetMs()))
  setPatience({ recoveryBudgetMinutes: 0 })
  check('custom with a budget of 0: the budget is off', budget.recoveryBudgetMs() === Infinity && budget.makeRecoveryBudget().capMs === Infinity)
  setPatience(undefined)
}

section('P4 — the env pins outrank the setting, every road alike')
{
  setPatience('patient')
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '2000'
  check('the idle pin: every road reads it, the quiet road and the roads with no number included', everyRoad([...FED_ROADS, ...QUIET_ROADS, ...OWN_ROADS], 2_000) && idle.streamIdleTimeoutMs() === 2_000, roadsRead([...FED_ROADS, ...QUIET_ROADS]))
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '500'
  check('an idle pin under the floor falls through to the setting', everyRoad(FED_ROADS, 180_000) && everyRoad(QUIET_ROADS, 1_800_000), roadsRead([...FED_ROADS, ...QUIET_ROADS]))
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = 'slow'
  check('an idle pin that does not parse falls through to the setting', everyRoad(FED_ROADS, 180_000), roadsRead(FED_ROADS))
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  process.env.MERCURY_API_TIMEOUT_MS = '8000'
  check('the request-budget pin is the fallback ceiling', patience.nonstreamingFallbackCeilingMs() === 8_000, String(patience.nonstreamingFallbackCeilingMs()))
  process.env.MERCURY_API_TIMEOUT_MS = '60s'
  check('a request-budget pin with a unit suffix reads as unset: the setting stands', patience.nonstreamingFallbackCeilingMs() === 1_800_000, String(patience.nonstreamingFallbackCeilingMs()))
  delete process.env.MERCURY_API_TIMEOUT_MS
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '0.1'
  check('the budget pin: six seconds', budget.recoveryBudgetMs() === 6_000, String(budget.recoveryBudgetMs()))
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '0'
  check('the budget pin at 0: the budget is off', budget.recoveryBudgetMs() === Infinity)
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = 'junk'
  check('a budget pin that does not parse falls through to the setting', budget.recoveryBudgetMs() === 2_400_000, String(budget.recoveryBudgetMs()))
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '-3'
  check('a negative budget pin falls through to the setting', budget.recoveryBudgetMs() === 2_400_000, String(budget.recoveryBudgetMs()))
  delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
  setPatience(undefined)
}

section('P5 — the words, the custom form, the pins named, the schema')
{
  check('the normal row', patience.patienceWords(patience.PATIENCE_NORMAL) === 'idle 1m 30s (OpenAI 15m) · fallback 15m · retry budget 20m', patience.patienceWords(patience.PATIENCE_NORMAL))
  check('the patient row', patience.patienceWords(patience.PATIENCE_PATIENT) === 'idle 3m (OpenAI 30m) · fallback 30m · retry budget 40m', patience.patienceWords(patience.PATIENCE_PATIENT))
  const off = patience.patienceOf({ streamIdleSeconds: 45, recoveryBudgetMinutes: 0 }).numbers
  check('a custom row with the budget off says so', patience.patienceWords(off) === 'idle 45 s (OpenAI 15m) · fallback 15m · no retry budget', patience.patienceWords(off))
  check('the custom form /config writes carries every number in the file\'s units', JSON.stringify(patience.customPatienceSetting(patience.PATIENCE_NORMAL)) === JSON.stringify({ streamIdleSeconds: 90, quietStreamIdleSeconds: 900, fallbackCeilingSeconds: 900, recoveryBudgetMinutes: 20 }), JSON.stringify(patience.customPatienceSetting(patience.PATIENCE_NORMAL)))
  check('…and reads back as the same numbers', JSON.stringify(patience.patienceOf(patience.customPatienceSetting(patience.PATIENCE_PATIENT)).numbers) === JSON.stringify(patience.PATIENCE_PATIENT))
  check('no pin set: none named', patience.patienceEnvPins().length === 0, JSON.stringify(patience.patienceEnvPins()))
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '2000'
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '0.1'
  check('the pins set are named with their values, in the row\'s order', JSON.stringify(patience.patienceEnvPins()) === JSON.stringify(['MERCURY_STREAM_IDLE_TIMEOUT_MS=2000', 'MERCURY_RECOVERY_BUDGET_MINUTES=0.1']), JSON.stringify(patience.patienceEnvPins()))
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
  const schema = SettingsSchema()
  const admits = (value: unknown): boolean => schema.safeParse({ patience: value }).success
  check('the schema admits normal, patient and the custom form', admits('normal') && admits('patient') && admits({ streamIdleSeconds: 45, recoveryBudgetMinutes: 0 }) && admits(undefined))
  check('the schema refuses a spelling outside the three', !admits('eager') && !admits({ streamIdleSeconds: -1 }) && !admits(7))
}

console.log(failures === 0 ? '\nprove-patience-numbers: all green' : `\nprove-patience-numbers: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
