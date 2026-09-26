#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-setting-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const configFile = join(HOME, '.mercury.json')
writeFileSync(
  configFile,
  JSON.stringify({
    hasCompletedOnboarding: true,
    numStartups: 3,
    jev: { enabled: 'yes', allowanceUsd: -3, pacePerMinute: 2.5, requestCeiling: 0, subagents: 1 },
  }),
)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.js')
const {
  JEV_DEFAULT_ALLOWANCE_USD,
  JEV_DEFAULT_PACE_PER_MINUTE,
  JEV_DOORS,
  JEV_MENU_ROW,
  jevEnabled,
  jevReceiptWords,
  jevSettingLines,
  jevSettingsFromStored,
  jevValueWords,
  readJevSettings,
  setJevAllowanceUsd,
  setJevEnabled,
  setJevPacePerMinute,
  setJevRequestCeiling,
  setJevSubagents,
} = setting

const readConfig = (): Record<string, unknown> => JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>

section('§1 off by default, and an off-shape stored block reads as the defaults')
const first = readJevSettings()
check('enabled is false (a stored "yes" is not true)', first.enabled === false)
check('allowance is the $20 default (a negative stored figure is ignored)', first.allowanceUsd === 20 && JEV_DEFAULT_ALLOWANCE_USD === 20)
check('pace is the 100-a-minute default (a fractional stored figure is ignored)', first.pacePerMinute === 100 && JEV_DEFAULT_PACE_PER_MINUTE === 100, `read ${first.pacePerMinute}; constant ${JEV_DEFAULT_PACE_PER_MINUTE}`)
check('an explicit stored pace of 10 is retained, not mistaken for the new default', jevSettingsFromStored({ pacePerMinute: 10 }).pacePerMinute === 10)
check('request ceiling is off (a stored 0 is not a ceiling)', first.requestCeiling === null)
check('sub-agents are off (a stored 1 is not true)', first.subagents === false)
check('jevEnabled() is the same truth as readJevSettings().enabled', jevEnabled() === first.enabled)
check('the stored bytes were not rewritten by a read', JSON.stringify(readConfig().jev) === JSON.stringify({ enabled: 'yes', allowanceUsd: -3, pacePerMinute: 2.5, requestCeiling: 0, subagents: 1 }))
check('an absent block reads as the defaults', JSON.stringify(jevSettingsFromStored(undefined)) === JSON.stringify(first))

const roadOf = (value: ReturnType<typeof readJevSettings>) => (value as unknown as { road?: string }).road
check('an absent road reads official', roadOf(jevSettingsFromStored(undefined)) === 'official')
for (const stray of ['unknown', null, 42]) {
  const stored = { road: stray, openrouterAllowanceUsd: -2 } as never
  const normalized = jevSettingsFromStored(stored)
  check('a stray road reads official with the default allowance, without throwing', roadOf(normalized) === 'official' && normalized.allowanceUsd === 20)
}
const separate = jevSettingsFromStored({ road: 'openrouter', allowanceUsd: 7, openrouterAllowanceUsd: 3 } as never)
check('OpenRouter selects only its own stored allowance', roadOf(separate) === 'openrouter' && separate.allowanceUsd === 3)
check('an invalid OpenRouter allowance defaults without borrowing the official one', jevSettingsFromStored({ road: 'openrouter', allowanceUsd: 7, openrouterAllowanceUsd: -1 } as never).allowanceUsd === 20)

section('§2 one writer, one truth: every setter lands in the one config key and reads back')
const on = setJevEnabled(true)
check('setJevEnabled(true) returns enabled', on.enabled === true)
check('readJevSettings() agrees', readJevSettings().enabled === true && jevEnabled() === true)
const storedOn = readConfig().jev as Record<string, unknown>
check('the config file carries jev.enabled true', storedOn.enabled === true)
check('the write trimmed the off-shape values instead of keeping them', !('allowanceUsd' in storedOn) && !('pacePerMinute' in storedOn) && !('requestCeiling' in storedOn) && !('subagents' in storedOn), JSON.stringify(storedOn))

const priced = setJevAllowanceUsd(5)
check('allowance $5 lands', priced.allowanceUsd === 5 && readJevSettings().allowanceUsd === 5 && (readConfig().jev as Record<string, unknown>).allowanceUsd === 5)
setJevAllowanceUsd(20)
check('the default allowance is not stored (absent = $20)', !('allowanceUsd' in (readConfig().jev as Record<string, unknown>)) && readJevSettings().allowanceUsd === 20)

const paced = setJevPacePerMinute(3)
check('pace 3 lands', paced.pacePerMinute === 3 && readJevSettings().pacePerMinute === 3)
setJevPacePerMinute(100)
check('the 100-a-minute default pace is not stored', !('pacePerMinute' in (readConfig().jev as Record<string, unknown>)))

const capped = setJevRequestCeiling(40)
check('request ceiling 40 lands', capped.requestCeiling === 40 && readJevSettings().requestCeiling === 40)
const uncapped = setJevRequestCeiling(null)
check('clearing the ceiling removes the key', uncapped.requestCeiling === null && !('requestCeiling' in (readConfig().jev as Record<string, unknown>)))

const withAgents = setJevSubagents(true)
check('sub-agents on lands', withAgents.subagents === true && readJevSettings().subagents === true)
setJevSubagents(false)
check('sub-agents off is not stored', !('subagents' in (readConfig().jev as Record<string, unknown>)))

setJevEnabled(false)
check('switching off with every other setting at its default removes the whole jev key', !('jev' in readConfig()), JSON.stringify(readConfig().jev))
check('and reads as off', jevEnabled() === false)

section('§3 a refused value never lands')
let threw = 0
for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  try {
    setJevAllowanceUsd(bad)
  } catch {
    threw++
  }
}
check('four bad allowances refused', threw === 4, String(threw))
threw = 0
for (const bad of [0, 1.5, -2]) {
  try {
    setJevPacePerMinute(bad)
  } catch {
    threw++
  }
}
check('three bad paces refused', threw === 3, String(threw))
threw = 0
for (const bad of [0, 0.5]) {
  try {
    setJevRequestCeiling(bad)
  } catch {
    threw++
  }
}
check('two bad ceilings refused', threw === 2, String(threw))
check('nothing landed from the refusals', !('jev' in readConfig()))

section('§4 the words every door speaks')
check('value words: off', jevValueWords(readJevSettings()) === 'off · official')
check('value words: on', jevValueWords({ ...readJevSettings(), enabled: true }) === 'on · official')
check('the on receipt names the roster and the key', /roster/.test(jevReceiptWords({ ...readJevSettings(), enabled: true })) && /key/.test(jevReceiptWords({ ...readJevSettings(), enabled: true })))
check('the off receipt says nothing is sent', /nothing is sent/.test(jevReceiptWords(readJevSettings())))
const lines = jevSettingLines(readJevSettings())
check('the setting lines carry allowance, pace, ceiling, sub-agents and the doors', lines.length === 5 && /\$20/.test(lines[0]!) && /100 requests a minute/.test(lines[1]!) && /off/.test(lines[2]!) && /off/.test(lines[3]!) && lines[4]!.includes(JEV_DOORS))
check('the allowance line calls it a runaway stop, never a budget', /runaway stop, not a budget/.test(lines[0]!))
check('the doors name the three surfaces', /\/jev/.test(JEV_DOORS) && /\/config/.test(JEV_DOORS) && /Boot Menu/.test(JEV_DOORS))
const ceilingLine = jevSettingLines({ ...readJevSettings(), requestCeiling: 7 })[2]!
check('a set ceiling reads as a count', /7 requests a session/.test(ceilingLine))
const agentLine = jevSettingLines({ ...readJevSettings(), subagents: true })[3]!
check('sub-agents on names the 200-call cap and shared 50/min session pace on the same allowance', /200 calls each/.test(agentLine) && /50 a minute per session/.test(agentLine) && /same allowance/.test(agentLine), agentLine)

section('§5 the Boot Menu row is a config-backed toggle on the Motion pattern')
check('env is the config key', JEV_MENU_ROW.env === 'jev')
check('a toggle whose one option is on and whose default is off', JEV_MENU_ROW.kind === 'toggle' && JEV_MENU_ROW.options.length === 1 && JEV_MENU_ROW.options[0] === 'on' && JEV_MENU_ROW.defaultLabel === 'off')
check('applies live', JEV_MENU_ROW.applicationClass === 'live')
check('the detail pane has controls, on and off lists', typeof JEV_MENU_ROW.detail.controls === 'string' && JEV_MENU_ROW.detail.on.length >= 2 && JEV_MENU_ROW.detail.off.length >= 1)
check('the row says it never answers a permission request', /never answers a permission request/.test(JEV_MENU_ROW.detail.controls))
check('no "experimental" anywhere in the row', !/experimental/i.test(JSON.stringify(JEV_MENU_ROW)))
check('no "experimental" in any setting words', !/experimental/i.test([jevReceiptWords(readJevSettings()), jevReceiptWords({ ...readJevSettings(), enabled: true }), ...jevSettingLines(readJevSettings()), JEV_DOORS].join(' ')))

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
