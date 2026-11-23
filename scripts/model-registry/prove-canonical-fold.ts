#!/usr/bin/env bun
import '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_MODEL_CONFIGS } = await import('../../src/models/facts/builtInModelTable.ts')
const existing = Object.entries(ALL_MODEL_CONFIGS)
const table = ALL_MODEL_CONFIGS as Record<string, { firstParty: string; canonical?: string }>
const future = 'claude-fable-5-7'
table.futureFixture = { firstParty: future }
const { getCanonicalName, getPublicModelDisplayName } = await import('../../src/models/catalogue/engineModel.ts')
const { MODEL_COSTS } = await import('../../src/models/usage/modelCost.ts')
const { classOfModel } = await import('../../src/models/roads/modelRegistry.ts')
const { getLaunchDefaultEffort, isLaunchEffortPinned } = await import('../../src/models/effort/effort.ts')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
delete table.futureFixture

let failures = 0
const check = (name: string, ok: boolean, detail = '', fix = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}${!ok && fix ? ` — to fix: ${fix}` : ''}`)
  if (!ok) failures++
}
const folds: Record<string, string> = {
  haiku35: 'claude-3-5-haiku', haiku45: 'claude-haiku-4-5',
  sonnet35: 'claude-3-5-sonnet', sonnet37: 'claude-3-7-sonnet', sonnet40: 'claude-sonnet-4', sonnet45: 'claude-sonnet-4-5',
  opus40: 'claude-opus-4', opus41: 'claude-opus-4-1', opus45: 'claude-opus-4-5', opus47: 'claude-opus-4-6', opus48: 'claude-opus-4-6',
  mythos5: 'claude-fable-5', mythos51: 'claude-fable-5-1', mythos52: 'claude-fable-5-2',
}
for (const [key, row] of existing) {
  const expected = folds[key] ?? row.firstParty
  check(`${key}: the existing canonical answer stands`, getCanonicalName(row.firstParty) === expected, getCanonicalName(row.firstParty), 'change getCanonicalName in src/models/facts/modelNames.ts, or the row canonical in src/models/facts/builtInModelTable.ts, so this row folds to the expected id')
  check(`${key}: case and context suffix keep the canonical`, getCanonicalName(`${row.firstParty.toUpperCase()}[1m]`) === expected, '', 'getCanonicalName in src/models/facts/modelNames.ts must ignore case and a [1m] suffix before folding')
  check(`${key}: carrier identity stays outside the first-party fold`, getCanonicalName(`openrouter/anthropic/${row.firstParty}`) === `openrouter/anthropic/${row.firstParty}`, '', 'getCanonicalName in src/models/facts/modelNames.ts must return a carrier-prefixed id unchanged')
  const canonical = (row as { canonical?: string }).canonical
  check(`${key}: a deliberate fold is declared`, canonical === folds[key], String(canonical), 'declare or remove canonical on this row in src/models/facts/builtInModelTable.ts, or update the folds table in this file if the fold is deliberate')
  if (canonical !== undefined) continue
  check(`${key}: an own-canonical row has an exact cost`, Object.hasOwn(MODEL_COSTS, row.firstParty), '', 'add an exact cost entry for this id to MODEL_COSTS in src/models/usage/modelCost.ts, or give the row a canonical in src/models/facts/builtInModelTable.ts')
  check(`${key}: an own-canonical row has a display name`, getPublicModelDisplayName(row.firstParty) !== null, '', 'add a display name for this id in getPublicModelDisplayName in src/models/catalogue/engineModel.ts')
  check(`${key}: an own-canonical row has a routing-class decision`, ([ALL_MODEL_CONFIGS.sonnet46.firstParty, ALL_MODEL_CONFIGS.haiku55.firstParty] as string[]).includes(row.firstParty) ? classOfModel(row.firstParty) === undefined : classOfModel(row.firstParty) !== undefined, '', 'declare the routing class of this id in classOfModel in src/models/roads/modelRegistry.ts (sonnet46 and haiku55 stay undefined)')
  const unpinned = [ALL_MODEL_CONFIGS.opus46.firstParty, ALL_MODEL_CONFIGS.sonnet46.firstParty, ALL_MODEL_CONFIGS.haiku55.firstParty] as string[]
  check(`${key}: an own-canonical row has a launch decision`, unpinned.includes(row.firstParty) ? !isLaunchEffortPinned(row.firstParty) && getLaunchDefaultEffort(row.firstParty) === 'high' : isLaunchEffortPinned(row.firstParty), '', 'declare the launch effort of this id in isLaunchEffortPinned and getLaunchDefaultEffort in src/models/effort/effort.ts')
}
check('the existing mirror point-release aliases keep their specific folds', getCanonicalName('claude-mythos-5-1') === 'claude-fable-5-1' && getCanonicalName('claude-mythos-5-2') === 'claude-fable-5-2', '', 'restore the mythos-to-fable point-release folds in getCanonicalName in src/models/facts/modelNames.ts')
check('a newly declared point release is its own canonical without another substring arm', getCanonicalName(future) === future, getCanonicalName(future), 'getCanonicalName in src/models/facts/modelNames.ts must return a declared point release as its own canonical without a new substring arm')
check('the synthetic point release still needs its own cost and display declarations', !Object.hasOwn(MODEL_COSTS, future) && getPublicModelDisplayName(future) === null, '', 'a synthetic point release must not appear in MODEL_COSTS (src/models/usage/modelCost.ts) or getPublicModelDisplayName (src/models/catalogue/engineModel.ts) until declared')
const undeclared: Array<[string, string]> = [
  ['claude-opus-5-7', 'claude-opus-5-7'],
  ['claude-sonnet-5-7', 'claude-sonnet-5-7'],
  ['claude-fable-5-3', 'claude-fable-5-3'],
  ['claude-haiku-5', 'claude-haiku-5'],
  ['claude-opus-6', 'claude-opus-6'],
  ['claude-opus-4-9', 'claude-opus-4-9'],
  ['claude-sonnet-4-7', 'claude-sonnet-4-7'],
  ['claude-haiku-4-6', 'claude-haiku-4-6'],
  ['claude-mythos-5-7', 'claude-fable-5-7'],
  ['claude-opus-5-7-20270101', 'claude-opus-5-7'],
  ['CLAUDE-OPUS-5-7[1m]', 'claude-opus-5-7'],
]
for (const [id, expected] of undeclared) {
  check(`an undeclared generation keeps its own stem: ${id}`, getCanonicalName(id) === expected, getCanonicalName(id), 'getCanonicalName in src/models/facts/modelNames.ts must keep an undeclared generation as its own stem')
}
const dated: Array<[string, string]> = [
  ['claude-opus-5-20260401', 'claude-opus-5'],
  ['claude-opus-5-5-20260401', 'claude-opus-5-5'],
  ['claude-sonnet-5-20260401', 'claude-sonnet-5'],
  ['claude-sonnet-5-5-20260401', 'claude-sonnet-5-5'],
  ['claude-fable-5-1-20260401', 'claude-fable-5-1'],
  ['claude-fable-5-2-20261109', 'claude-fable-5-2'],
  ['claude-mythos-5-2-20261109', 'claude-fable-5-2'],
  ['claude-opus-4-5-20260101', 'claude-opus-4-5'],
  ['claude-opus-4-8-20260101', 'claude-opus-4-6'],
  ['claude-opus-4-20990101', 'claude-opus-4'],
  ['claude-haiku-4-5-20260101', 'claude-haiku-4-5'],
  ['us.anthropic.claude-opus-5-v1:0', 'claude-opus-5'],
  ['anthropic.claude-opus-4-8-v1:0', 'claude-opus-4-6'],
  ['claude-mythos-5-20260401', 'claude-fable-5'],
]
for (const [id, expected] of dated) {
  check(`a dated or gateway spelling of a declared generation folds onto it: ${id}`, getCanonicalName(id) === expected, getCanonicalName(id), 'getCanonicalName in src/models/facts/modelNames.ts must strip the date or gateway wrapper and fold onto the declared generation')
}
check('a carrier-shaped undeclared generation keeps the carrier identity', getCanonicalName('openrouter/anthropic/claude-opus-5-7') === 'openrouter/anthropic/claude-opus-5-7', '', 'getCanonicalName in src/models/facts/modelNames.ts must keep the carrier prefix on an undeclared generation')
check('an id of a family the table does not declare is its own generic canonical', getCanonicalName('claude-zephyr-1') === 'claude-zephyr-1' && getCanonicalName('claude-zephyr-1-20260101') === 'claude-zephyr-1-20260101', '', 'getCanonicalName in src/models/facts/modelNames.ts must return an unknown family id unchanged, date included')
check('the older naming scheme still folds through its own arms', getCanonicalName('claude-3-7-sonnet-latest') === 'claude-3-7-sonnet' && getCanonicalName('claude-3-5-haiku-latest') === 'claude-3-5-haiku', '', 'getCanonicalName in src/models/facts/modelNames.ts must keep the arms for the older naming scheme and its -latest suffix')
process.exit(failures === 0 ? 0 : 1)
