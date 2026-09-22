#!/usr/bin/env bun
import '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.ts')
const existing = Object.entries(ALL_MODEL_CONFIGS)
const table = ALL_MODEL_CONFIGS as Record<string, { firstParty: string; canonical?: string }>
const future = 'claude-fable-5-2'
table.futureFixture = { firstParty: future }
const { getCanonicalName, getPublicModelDisplayName } = await import('../../src/utils/model/model.ts')
const { MODEL_COSTS } = await import('../../src/utils/modelCost.ts')
const { classOfModel } = await import('../../src/utils/router/modelRegistry.ts')
const { getLaunchDefaultEffort, isLaunchEffortPinned } = await import('../../src/utils/effort.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
delete table.futureFixture

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const folds: Record<string, string> = {
  haiku35: 'claude-3-5-haiku', haiku45: 'claude-haiku-4-5',
  sonnet35: 'claude-3-5-sonnet', sonnet37: 'claude-3-7-sonnet', sonnet40: 'claude-sonnet-4', sonnet45: 'claude-sonnet-4-5',
  opus40: 'claude-opus-4', opus41: 'claude-opus-4-1', opus45: 'claude-opus-4-5', opus47: 'claude-opus-4-6', opus48: 'claude-opus-4-6',
  mythos5: 'claude-fable-5',
}
for (const [key, row] of existing) {
  const expected = folds[key] ?? row.firstParty
  check(`${key}: the existing canonical answer stands`, getCanonicalName(row.firstParty) === expected, getCanonicalName(row.firstParty))
  check(`${key}: case and context suffix keep the canonical`, getCanonicalName(`${row.firstParty.toUpperCase()}[1m]`) === expected)
  check(`${key}: carrier identity stays outside the first-party fold`, getCanonicalName(`openrouter/anthropic/${row.firstParty}`) === `openrouter/anthropic/${row.firstParty}`)
  const canonical = (row as { canonical?: string }).canonical
  check(`${key}: a deliberate fold is declared`, canonical === folds[key], String(canonical))
  if (canonical !== undefined) continue
  check(`${key}: an own-canonical row has an exact cost`, Object.hasOwn(MODEL_COSTS, row.firstParty))
  check(`${key}: an own-canonical row has a display name`, getPublicModelDisplayName(row.firstParty) !== null)
  check(`${key}: an own-canonical row has a routing-class decision`, row.firstParty === ALL_MODEL_CONFIGS.sonnet46.firstParty ? classOfModel(row.firstParty) === undefined : classOfModel(row.firstParty) !== undefined)
  const unpinned = [ALL_MODEL_CONFIGS.opus46.firstParty, ALL_MODEL_CONFIGS.sonnet46.firstParty] as string[]
  check(`${key}: an own-canonical row has a launch decision`, unpinned.includes(row.firstParty) ? !isLaunchEffortPinned(row.firstParty) && getLaunchDefaultEffort(row.firstParty) === 'high' : isLaunchEffortPinned(row.firstParty))
}
check('the existing mirror point-release alias keeps its specific fold', getCanonicalName('claude-mythos-5-1') === 'claude-fable-5-1')
check('a newly declared point release is its own canonical without another substring arm', getCanonicalName(future) === future, getCanonicalName(future))
check('the synthetic point release still needs its own cost and display declarations', !Object.hasOwn(MODEL_COSTS, future) && getPublicModelDisplayName(future) === null)
process.exit(failures === 0 ? 0 : 1)
