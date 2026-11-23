#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'picker-rows-proof-'))
delete process.env.ZAI_API_KEY
delete process.env.MOONSHOT_API_KEY
delete process.env.DEEPSEEK_API_KEY
delete process.env.MERCURY_COMPAT_BASE_URL

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const {
  keyLaneProviderRows,
  keyLaneGroupRows,
  keyConnectValue,
  parseKeyConnectValue,
  isProviderActionRow,
  ZAI_MODEL_GROUP,
  MOONSHOT_MODEL_GROUP,
  DEEPSEEK_MODEL_GROUP,
  COMPAT_MODEL_GROUP,
} = await import('../../src/models/catalogue/modelOptions.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

section('1 · one lane, both credential states (the grammar)')
{
  const pins = [
    { id: 'kimi-k3', displayName: 'Kimi K3', observedAt: '2026-08-21', contextWindow: 1_048_576 },
    { id: 'kimi-k2.6', displayName: 'Kimi K2.6', observedAt: '2026-08-21' },
  ]
  const present = keyLaneGroupRows({
    group: MOONSHOT_MODEL_GROUP,
    providerName: 'Moonshot',
    connectValue: keyConnectValue('moonshot'),
    connectHint: 'hint',
    keyPresent: true,
    pins,
  })
  check('credentialed ⇒ every pin selectable', present.length === 2 && present.every(r => r.unavailable === undefined), `rows ${present.length}; with keyPresent true, keyLaneGroupRows in src/models/catalogue/modelOptions.ts must return one selectable row per pin`)
  check('credentialed ⇒ no action row', !present.some(r => r.value !== null && isProviderActionRow(r.value)), 'with keyPresent true, keyLaneGroupRows in src/models/catalogue/modelOptions.ts must not emit the connect action row')
  check('model rows carry no description; a stated window rides the typed field (the neutral grammar)', present.every(r => r.description === '') && present[0]?.statedContextWindow === 1_048_576 && present[1]?.statedContextWindow === undefined, JSON.stringify(present.map(r => [r.value, r.description, r.statedContextWindow])) + ' — keyLaneGroupRows in src/models/catalogue/modelOptions.ts must give model rows an empty description and carry a pin contextWindow in statedContextWindow')

  const absent = keyLaneGroupRows({
    group: MOONSHOT_MODEL_GROUP,
    providerName: 'Moonshot',
    connectValue: keyConnectValue('moonshot'),
    connectHint: 'hint',
    keyPresent: false,
    pins,
  })
  check('absent ⇒ the action row rides FIRST', absent[0]?.value === keyConnectValue('moonshot'), `first row ${String(absent[0]?.value)}; with keyPresent false, keyLaneGroupRows in src/models/catalogue/modelOptions.ts must put the connect row (keyConnectValue) first`)
  check(
    'absent ⇒ the whole lineup visible-but-unavailable',
    absent.length === 3 && absent.slice(1).every(r => r.unavailable !== undefined),
    `rows ${absent.length}; with keyPresent false, keyLaneGroupRows in src/models/catalogue/modelOptions.ts must emit the action row plus every pin marked unavailable`,
  )
  check('absent ⇒ nothing selectable but the action', absent.filter(r => r.unavailable === undefined).length === 1, 'with keyPresent false, keyLaneGroupRows in src/models/catalogue/modelOptions.ts must leave only the action row without an unavailable marker')
}

section('2 · every lane present in the derived row set (never hidden)')
{
  const rows = keyLaneProviderRows({
    zaiKeyPresent: () => false,
    moonshotCredentialPresent: () => true,
    deepseekKeyPresent: () => false,
    compat: () => undefined,
  })
  const groups = new Set(rows.map(r => r.group))
  check(
    'all four groups paint',
    groups.has(ZAI_MODEL_GROUP) && groups.has(MOONSHOT_MODEL_GROUP) && groups.has(DEEPSEEK_MODEL_GROUP) && groups.has(COMPAT_MODEL_GROUP),
    [...groups].join(' | ') + ' — keyLaneProviderRows in src/models/catalogue/modelOptions.ts must emit a group for every lane whatever its credential state',
  )
  check(
    'zai lineup includes glm-5.3 (the flagship pin)',
    rows.some(r => r.group === ZAI_MODEL_GROUP && r.value === 'glm-5.3'),
    'keyLaneProviderRows in src/models/catalogue/modelOptions.ts must include glm-5.3 in the ZAI_MODEL_GROUP lineup',
  )
  check(
    'credentialed moonshot rows selectable',
    rows.filter(r => r.group === MOONSHOT_MODEL_GROUP).every(r => r.unavailable === undefined),
    'when moonshotCredentialPresent returns true, keyLaneProviderRows in src/models/catalogue/modelOptions.ts must leave the moonshot rows selectable',
  )
  check(
    'uncredentialed deepseek lineup visible-but-unavailable',
    rows.some(r => r.group === DEEPSEEK_MODEL_GROUP && r.unavailable !== undefined),
    'when deepseekKeyPresent returns false, keyLaneProviderRows in src/models/catalogue/modelOptions.ts must still list the deepseek lineup marked unavailable',
  )
  check(
    'unconfigured compat ⇒ the configure action row',
    rows.some(r => r.group === COMPAT_MODEL_GROUP && r.value === keyConnectValue('compat')),
    'when compat returns undefined, keyLaneProviderRows in src/models/catalogue/modelOptions.ts must emit the compat configure action row',
  )
}

section('3 · the compat slot states')
{
  const named = keyLaneProviderRows({
    zaiKeyPresent: () => false,
    moonshotCredentialPresent: () => false,
    deepseekKeyPresent: () => false,
    compat: () => ({ label: 'LM Studio', models: ['qwen3-32b', 'llama-3.3-70b'], keyPresent: false }),
  }).filter(r => r.group === COMPAT_MODEL_GROUP)
  check(
    'named models ⇒ compat/<id> rows, selectable, no description (the neutral grammar)',
    named.length === 2 &&
      named[0]?.value === 'compat/qwen3-32b' &&
      named.every(r => r.unavailable === undefined && r.description === ''),
    JSON.stringify(named.map(r => [r.value, r.description, r.unavailable])) + ' — keyLaneProviderRows in src/models/catalogue/modelOptions.ts must emit one selectable compat/<id> row per named model, with an empty description',
  )
  const unnamed = keyLaneProviderRows({
    zaiKeyPresent: () => false,
    moonshotCredentialPresent: () => false,
    deepseekKeyPresent: () => false,
    compat: () => ({ label: 'corp proxy', models: [], keyPresent: true }),
  }).filter(r => r.group === COMPAT_MODEL_GROUP)
  check(
    'configured-but-unnamed ⇒ the name-models action row',
    unnamed.length === 1 && unnamed[0]?.value === keyConnectValue('compat') && unnamed[0].label.includes('corp proxy'),
    JSON.stringify(unnamed.map(r => [r.value, r.label])) + ' — when compat has no models, keyLaneProviderRows in src/models/catalogue/modelOptions.ts must emit the single name-models action row labelled with the slot label',
  )
}

section('4 · sentinel parsing')
{
  for (const lane of ['zai', 'moonshot', 'deepseek', 'compat'] as const) {
    check(`connect value round-trips (${lane})`, parseKeyConnectValue(keyConnectValue(lane)) === lane, 'parseKeyConnectValue must invert keyConnectValue (src/models/catalogue/modelOptions.ts)')
    check(`connect value is an ACTION (${lane})`, isProviderActionRow(keyConnectValue(lane)), 'isProviderActionRow must recognise what keyConnectValue builds (src/models/catalogue/modelOptions.ts)')
  }
  check('a model id is never an action', !isProviderActionRow('kimi-k3'), 'isProviderActionRow in src/models/catalogue/modelOptions.ts must return false for a plain model id')
  check('junk connect refuses', parseKeyConnectValue('__mercury_connect__:bogus') === undefined, 'parseKeyConnectValue in src/models/catalogue/modelOptions.ts must return undefined for an unknown lane name')
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
