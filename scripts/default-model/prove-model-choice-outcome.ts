#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MODEL

const { proofHome } = await import('../lib/hermetic.ts')
const { persistModelChoice } = await import('../../src/commands/model/persistModelChoice.ts')
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const settingsPath = join(proofHome, 'settings.json')
const storedModel = (): unknown => {
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf8')) as { model?: unknown }).model
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

section('§4 a refused write: the outcome says refused and the sentence carries the reason')
{
  writeFileSync(settingsPath, '{ "model": "env-fixture-model", ')
  const refused = persistModelChoice('claude-fixture-three')
  check('the outcome is refused', outcomeOf(refused) === 'refused', JSON.stringify(refused))
  check('the sentence names the refusal', sentenceOf(refused).startsWith(' · not saved as your default: ') && sentenceOf(refused).includes('Invalid JSON'), JSON.stringify(refused))
  }

section('§5 the callers read the outcome, never the words')
{
  const picker = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  const verb = readFileSync(join(ROOT, 'src/commands/model/model.tsx'), 'utf8')
  check('the default picker decides on the outcome', picker.includes("if (saved.outcome !== 'saved') {") && picker.includes('setNotice(saved.sentence)'))
  check('the receipt words live in the owner alone', !picker.includes('saved as your default') && !verb.includes('saved as your default'))
  check('the painting callers take the sentence', picker.split('persistModelChoice(value).sentence').length - 1 === 2 && verb.split('persistModelChoice(target).sentence').length - 1 === 2)
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
