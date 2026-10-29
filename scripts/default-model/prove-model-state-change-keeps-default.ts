#!/usr/bin/env bun

import '../lib/hermetic.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MODEL

const { proofHome } = await import('../lib/hermetic.ts')
const { onChangeAppState } = await import('../../src/state/onChangeAppState.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getEngineModelOverride, setEngineModelOverride } = await import('../../src/bootstrap/state.ts')
const { persistModelChoice } = await import('../../src/commands/model/persistModelChoice.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const settingsPath = join(proofHome, 'settings.json')
const SAVED = JSON.stringify({ engine: { model: 'claude-opus-5-5', effort: 'max' } }, null, 2) + '\n'
const storedModel = (): unknown => {
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: { model?: unknown } }).engine?.model
  } catch {
    return undefined
  }
}
writeFileSync(settingsPath, SAVED)
const base = getDefaultAppState()
const change = (from: string | null, to: string | null): void =>
  onChangeAppState({ oldState: { ...base, engineModel: from }, newState: { ...base, engineModel: to } })

section('§1 the model this process runs on may move without the saved default moving: a state change writes nothing to settings.json')
{
  writeFileSync(settingsPath, SAVED)
  setEngineModelOverride(undefined)
  change(null, 'glm-5.3')
  check('the live model follows the state (the engine override reads the new model)', getEngineModelOverride() === 'glm-5.3', String(getEngineModelOverride()))
  check('settings.json is byte-identical — the saved default is still the user\'s own', readFileSync(settingsPath, 'utf8') === SAVED, readFileSync(settingsPath, 'utf8'))
  change('glm-5.3', 'claude-opus-5-5')
  check('moving back leaves the file alone too', readFileSync(settingsPath, 'utf8') === SAVED && getEngineModelOverride() === 'claude-opus-5-5', readFileSync(settingsPath, 'utf8'))
}

section('§2 a state change to no model never clears a saved default')
{
  writeFileSync(settingsPath, SAVED)
  change('claude-opus-5-5', null)
  check('the live override is cleared', getEngineModelOverride() === undefined, String(getEngineModelOverride()))
  check('the saved default survives', storedModel() === 'claude-opus-5-5' && readFileSync(settingsPath, 'utf8') === SAVED, readFileSync(settingsPath, 'utf8'))
}

section('§3 the explicit pick is the one road that saves the default, and it says so')
{
  writeFileSync(settingsPath, SAVED)
  const choice = persistModelChoice('glm-5.3')
  check('the pick writes the default', storedModel() === 'glm-5.3', String(storedModel()))
  check('and its receipt says saved', choice.outcome === 'saved' && choice.sentence === ' · saved as your default', JSON.stringify(choice))
  choice.restore()
  check('the pick\'s way back restores the earlier default', storedModel() === 'claude-opus-5-5', String(storedModel()))
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
