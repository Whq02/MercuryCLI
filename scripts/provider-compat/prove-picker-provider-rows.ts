#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-picker-provider-rows.ts — the /model picker's
//  key-lane groups: the GPT dual-support grammar
//  held for every API-key provider, over injected reads (hermetic).
//
//    · HONESTY — a credentialed lane's pins are selectable rows; an absent
//      lane shows ONE attach-a-key action row FIRST, then the whole lineup
//      visible-but-unavailable (never a hidden provider, never a selectable
//      row without a credential).
//    · COMPAT SLOT — unconfigured ⇒ one configure action row (the group
//      never vanishes); configured with models ⇒ compat/<id> rows;
//      configured without models ⇒ the name-models action row.
//    · SENTINELS — connect values parse back to their lane and are ACTIONS
//      (isProviderActionRow), never models.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-picker-provider-rows.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'picker-rows-proof-'))
delete process.env.ZAI_API_KEY
delete process.env.MOONSHOT_API_KEY
delete process.env.DEEPSEEK_API_KEY
delete process.env.MERCURY_COMPAT_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
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
} = await import('../../src/utils/model/modelOptions.ts')

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
  check('credentialed ⇒ every pin selectable', present.length === 2 && present.every(r => r.unavailable === undefined))
  check('credentialed ⇒ no action row', !present.some(r => r.value !== null && isProviderActionRow(r.value)))
  check('model rows carry no description; a stated window rides the typed field (the neutral grammar)', present.every(r => r.description === '') && present[0]?.statedContextWindow === 1_048_576 && present[1]?.statedContextWindow === undefined, JSON.stringify(present.map(r => [r.value, r.description, r.statedContextWindow])))

  const absent = keyLaneGroupRows({
    group: MOONSHOT_MODEL_GROUP,
    providerName: 'Moonshot',
    connectValue: keyConnectValue('moonshot'),
    connectHint: 'hint',
    keyPresent: false,
    pins,
  })
  check('absent ⇒ the action row rides FIRST', absent[0]?.value === keyConnectValue('moonshot'))
  check(
    'absent ⇒ the whole lineup visible-but-unavailable',
    absent.length === 3 && absent.slice(1).every(r => r.unavailable !== undefined),
  )
  check('absent ⇒ nothing selectable but the action', absent.filter(r => r.unavailable === undefined).length === 1)
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
    [...groups].join(' | '),
  )
  check(
    'zai lineup includes glm-5.3 (the flagship pin)',
    rows.some(r => r.group === ZAI_MODEL_GROUP && r.value === 'glm-5.3'),
  )
  check(
    'credentialed moonshot rows selectable',
    rows.filter(r => r.group === MOONSHOT_MODEL_GROUP).every(r => r.unavailable === undefined),
  )
  check(
    'uncredentialed deepseek lineup visible-but-unavailable',
    rows.some(r => r.group === DEEPSEEK_MODEL_GROUP && r.unavailable !== undefined),
  )
  check(
    'unconfigured compat ⇒ the configure action row',
    rows.some(r => r.group === COMPAT_MODEL_GROUP && r.value === keyConnectValue('compat')),
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
  )
}

section('4 · sentinel parsing')
{
  for (const lane of ['zai', 'moonshot', 'deepseek', 'compat'] as const) {
    check(`connect value round-trips (${lane})`, parseKeyConnectValue(keyConnectValue(lane)) === lane)
    check(`connect value is an ACTION (${lane})`, isProviderActionRow(keyConnectValue(lane)))
  }
  check('a model id is never an action', !isProviderActionRow('kimi-k3'))
  check('junk connect refuses', parseKeyConnectValue('__mercury_connect__:bogus') === undefined)
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
