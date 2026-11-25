#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MODEL

const { proofHome } = await import('../lib/hermetic.ts')
const { persistEffortChoice, persistModelChoice } = await import('../../src/commands/model/persistModelChoice.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + 'fix persistModelChoice / persistEffortChoice in src/commands/model/persistModelChoice.ts (outcome, receipt sentence, or the write to settings.json)' : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const settingsPath = join(proofHome, 'settings.json')
const storedModel = (): unknown => {
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: { model?: unknown } }).engine?.model
  } catch {
    return undefined
  }
}
const storedEffort = (): unknown => {
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: { effort?: unknown } }).engine?.effort
  } catch {
    return undefined
  }
}
const outcomeOf = (value: unknown): unknown => (typeof value === 'object' && value !== null ? (value as { outcome?: unknown }).outcome : undefined)
const sentenceOf = (value: unknown): string => (typeof value === 'object' && value !== null ? String((value as { sentence?: unknown }).sentence ?? '') : String(value))

section('§1 a saved choice: the outcome says saved and the sentence keeps its words')
{
  const first = persistModelChoice('claude-fixture-one')
  check('the outcome is saved', outcomeOf(first) === 'saved', JSON.stringify(first))
  check('the sentence is the receipt as painted today', sentenceOf(first) === ' · saved as your default', JSON.stringify(first))
  check('the default is in the settings file', storedModel() === 'claude-fixture-one', String(storedModel()))
  const again = persistModelChoice('claude-fixture-one')
  check('the same choice again is still saved, with the same sentence', outcomeOf(again) === 'saved' && sentenceOf(again) === ' · saved as your default', JSON.stringify(again))
}

section('§2 a launch override: saved, and the outcome says the boot will override it')
{
  process.env.MERCURY_MODEL = 'env-fixture-model'
  const overridden = persistModelChoice('claude-fixture-two')
  check('the outcome is overridden', outcomeOf(overridden) === 'overridden', JSON.stringify(overridden))
  check('the sentence names the override', sentenceOf(overridden) === ' · saved as your default, but MERCURY_MODEL=env-fixture-model overrides it at boot', JSON.stringify(overridden))
  check('the default was still written', storedModel() === 'claude-fixture-two', String(storedModel()))
  const same = persistModelChoice('env-fixture-model')
  check('a choice equal to the override is plainly saved', outcomeOf(same) === 'saved' && sentenceOf(same) === ' · saved as your default', JSON.stringify(same))
  delete process.env.MERCURY_MODEL
}

section('§3 clearing the default: cleared once, then unchanged with nothing to say')
{
  const cleared = persistModelChoice(null)
  check('the outcome is cleared', outcomeOf(cleared) === 'cleared', JSON.stringify(cleared))
  check('the sentence is the clearing receipt as painted today', sentenceOf(cleared) === ' · your saved default model is cleared, new sessions start on the family default', JSON.stringify(cleared))
  check('no default remains in the file', storedModel() === undefined, String(storedModel()))
  const unchanged = persistModelChoice(null)
  check('clearing an empty default is unchanged, with an empty sentence', outcomeOf(unchanged) === 'unchanged' && sentenceOf(unchanged) === '', JSON.stringify(unchanged))
}

section('§4 a refused write: the outcome says refused, the sentence is plain, and the detail goes to the debug log')
{
  const { readFileSync } = await import('node:fs')
  const dbg = await import('../../src/platform/logs/debugLog.ts')
  const prevNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  dbg.enableDebugLogging()
  const dbgPath = dbg.getDebugLogPath()
  try {
    writeFileSync(settingsPath, '{ "engine": { "model": "env-fixture-model" }, ')
    const refused = persistModelChoice('claude-fixture-three')
    await dbg.flushDebugLogs()
    const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
    check('the outcome is refused', outcomeOf(refused) === 'refused', JSON.stringify(refused))
    check(
      'the sentence is plain and the debug log carries file and reason',
      sentenceOf(refused) === ' · not saved as your default — try again' && dbgText.includes('settings.json') && dbgText.includes('Invalid JSON'),
      `${JSON.stringify(refused)} | dbg=${dbgText.slice(-200)}`,
    )
  } finally {
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv
  }
}

section('§4b the effort ladder saves through the same owner: its outcome and its sentence are the owner\'s')
{
  const refusedEffort = persistEffortChoice('high')
  check('a refused effort write says refused with the plain sentence', outcomeOf(refusedEffort) === 'refused' && sentenceOf(refusedEffort) === ' · not saved as your default — try again', JSON.stringify(refusedEffort))
  check('a refused write leaves no effort in the file', storedEffort() === undefined, String(storedEffort()))
  writeFileSync(settingsPath, '{}')
  const savedEffort = persistEffortChoice('high')
  check('a saved effort pick says saved, with the receipt as painted today', outcomeOf(savedEffort) === 'saved' && sentenceOf(savedEffort) === ' · saved as your default for future sessions', JSON.stringify(savedEffort))
  check('the effort default is in the settings file', storedEffort() === 'high', String(storedEffort()))
}


console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
