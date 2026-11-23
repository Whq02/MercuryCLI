#!/usr/bin/env bun
// gate-watch: src/screen/app-state/onChangeAppState.ts src/commands/model/persistModelChoice.ts src/boot/process-state/processState.ts
import '../lib/hermetic.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MODEL

const { proofHome } = await import('../lib/hermetic.ts')
const { onChangeAppState } = await import('../../src/screen/app-state/onChangeAppState.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { getEngineModelOverride, setEngineModelOverride } = await import('../../src/boot/process-state/processState.ts')
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
  check('the live model follows the state (the engine override reads the new model)', getEngineModelOverride() === 'glm-5.3', String(getEngineModelOverride()) + ' | onChangeAppState in src/screen/app-state/onChangeAppState.ts must set the engine override from newState.engineModel')
  check('settings.json is byte-identical — the saved default is still the user\'s own', readFileSync(settingsPath, 'utf8') === SAVED, readFileSync(settingsPath, 'utf8') + ' | onChangeAppState in src/screen/app-state/onChangeAppState.ts must not write settings.json; only persistModelChoice in src/commands/model/persistModelChoice.ts saves the default')
  change('glm-5.3', 'claude-opus-5-5')
  check('moving back leaves the file alone too', readFileSync(settingsPath, 'utf8') === SAVED && getEngineModelOverride() === 'claude-opus-5-5', readFileSync(settingsPath, 'utf8') + ' | onChangeAppState in src/screen/app-state/onChangeAppState.ts must neither write settings.json nor skip the override update on a model change')
}

section('§2 a state change to no model never clears a saved default')
{
  writeFileSync(settingsPath, SAVED)
  change('claude-opus-5-5', null)
  check('the live override is cleared', getEngineModelOverride() === undefined, String(getEngineModelOverride()) + ' | onChangeAppState in src/screen/app-state/onChangeAppState.ts must clear the engine override when engineModel becomes null')
  check('the saved default survives', storedModel() === 'claude-opus-5-5' && readFileSync(settingsPath, 'utf8') === SAVED, readFileSync(settingsPath, 'utf8') + ' | onChangeAppState in src/screen/app-state/onChangeAppState.ts must not clear or rewrite the saved engine.model when engineModel becomes null')
}

section('§3 the explicit pick is the one road that saves the default, and it says so')
{
  writeFileSync(settingsPath, SAVED)
  const choice = persistModelChoice('glm-5.3')
  check('the pick writes the default', storedModel() === 'glm-5.3', String(storedModel()) + ' | persistModelChoice in src/commands/model/persistModelChoice.ts must write engine.model to settings.json')
  check('and its receipt says saved', choice.outcome === 'saved' && choice.sentence === ' · saved as your default', JSON.stringify(choice) + ' | persistModelChoice in src/commands/model/persistModelChoice.ts must return outcome saved with that sentence')
  choice.restore()
  check('the pick\'s way back restores the earlier default', storedModel() === 'claude-opus-5-5', String(storedModel()) + ' | the restore returned by persistModelChoice in src/commands/model/persistModelChoice.ts must write the earlier engine.model back')
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
