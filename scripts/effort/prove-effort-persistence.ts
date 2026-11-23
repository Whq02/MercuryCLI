#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'effort-persist-'))
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
const t = (name: string, ok: boolean, detail = '', fixHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && fixHint ? ` — change: ${fixHint}` : ''}`)
  if (!ok) failures = 1
}

const home = process.env.MERCURY_CONFIG_DIR
const effort = await import('../../src/models/effort/effort.js')
const settings = await import('../../src/platform/settings/settings.js')

console.log('— the persistable ladder —')
t("toPersistableEffort('max') persists", effort.toPersistableEffort('max') === 'max', '', 'toPersistableEffort in src/models/effort/effort.ts')
t("toPersistableEffort('xhigh') still persists", effort.toPersistableEffort('xhigh') === 'xhigh', '', 'toPersistableEffort in src/models/effort/effort.ts')
t('a word above the ladder never persists (the ladder ends at max)', effort.toPersistableEffort('ultra' as never) === undefined, '', 'toPersistableEffort in src/models/effort/effort.ts must return undefined for a word off the ladder')
t('numeric (ant-only) values never persist', effort.toPersistableEffort(3) === undefined, '', 'toPersistableEffort in src/models/effort/effort.ts must return undefined for a number')
t('undefined stays undefined', effort.toPersistableEffort(undefined) === undefined, '', 'toPersistableEffort in src/models/effort/effort.ts')

console.log('— the max default round-trip (write → disk → boot read) —')
const w1 = settings.updateSettingsForSource('userSettings', {
  engine: { effort: 'max' },
})
t('max-default write lands', w1.error === null, String(w1.error), 'updateSettingsForSource in src/platform/settings/settings.ts and the engine.effort entry of the settings schema must accept max')
const settingsFile = readdirSync(home).find(f => f.endsWith('.json'))
const read = (): Record<string, unknown> => JSON.parse(readFileSync(join(home, settingsFile!), 'utf8')) as Record<string, unknown>
const engineOf = (raw: Record<string, unknown>): Record<string, unknown> => (raw.engine ?? {}) as Record<string, unknown>
const raw1 = settingsFile ? read() : {}
t('settings file exists on disk', settingsFile !== undefined, readdirSync(home).join(','), 'updateSettingsForSource in src/platform/settings/settings.ts must write the user settings file into MERCURY_CONFIG_DIR')
t('disk carries engine.effort max', engineOf(raw1).effort === 'max', '', 'updateSettingsForSource in src/platform/settings/settings.ts must store engine.effort as written')
t('disk carries the one effort key and nothing beside it', [...Object.keys(raw1), ...Object.keys(engineOf(raw1))].filter(k => /effort|supercode/i.test(k)).join(',') === 'effort', JSON.stringify(raw1), 'updateSettingsForSource in src/platform/settings/settings.ts must write only engine.effort for an effort setting')
t('getInitialEffortSetting reads max back', effort.getInitialEffortSetting() === 'max', '', 'getInitialEffortSetting in src/models/effort/effort.ts must read engine.effort from the settings')

console.log('— the /effort <level> shape —')
const w2 = settings.updateSettingsForSource('userSettings', {
  engine: { effort: 'xhigh' },
})
t('level write lands', w2.error === null, String(w2.error), 'updateSettingsForSource in src/platform/settings/settings.ts and the engine.effort entry of the settings schema must accept xhigh')
t('level persisted', engineOf(read()).effort === 'xhigh', '', 'updateSettingsForSource in src/platform/settings/settings.ts must store engine.effort as written')

console.log('— the /effort auto shape clears the default —')
settings.updateSettingsForSource('userSettings', {
  engine: { effort: 'max' },
})
const w3 = settings.updateSettingsForSource('userSettings', {
  engine: { effort: undefined },
})
t('auto write lands', w3.error === null, String(w3.error), 'updateSettingsForSource in src/platform/settings/settings.ts must accept engine.effort undefined')
t('auto deletes the key on disk', !('effort' in engineOf(read())), '', 'updateSettingsForSource in src/platform/settings/settings.ts must delete a key set to undefined')
t('getInitialEffortSetting reads auto (undefined)', effort.getInitialEffortSetting() === undefined, '', 'getInitialEffortSetting in src/models/effort/effort.ts must answer undefined once engine.effort is gone')

console.log('— a stored word above the ladder degrades to absent (an earlier release wrote it; the schema no longer admits it) —')
const w4 = settings.updateSettingsForSource('userSettings', { engine: { effort: 'ultra' as never } })
t('a stored word off the ladder never reaches the boot read: the write is refused typed, or it lands and the read answers auto (undefined) — never the word, never a crash', w4.error !== null || effort.getInitialEffortSetting() === undefined, `error=${String(w4.error)} read=${String(effort.getInitialEffortSetting())}`, 'the engine.effort entry of the settings schema or getInitialEffortSetting in src/models/effort/effort.ts must drop a word off the ladder')


console.log(failures ? '\n❌ EFFORT-PERSISTENCE RED' : '\n✅ EFFORT-PERSISTENCE GREEN')
process.exit(failures)
