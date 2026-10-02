#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'effort-persist-'))
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const home = process.env.MERCURY_CONFIG_DIR
const effort = await import('../../src/utils/effort.js')
const settings = await import('../../src/utils/settings/settings.js')

console.log('— the persistable ladder —')
t("toPersistableEffort('max') persists", effort.toPersistableEffort('max') === 'max')
t("toPersistableEffort('xhigh') still persists", effort.toPersistableEffort('xhigh') === 'xhigh')
t('a word above the ladder never persists (the ladder ends at max)', effort.toPersistableEffort('ultra' as never) === undefined)
t('numeric (ant-only) values never persist', effort.toPersistableEffort(3) === undefined)
t('undefined stays undefined', effort.toPersistableEffort(undefined) === undefined)

console.log('— the max default round-trip (write → disk → boot read) —')
const w1 = settings.updateSettingsForSource('userSettings', {
  engine: { effort: 'max' },
})
t('max-default write lands', w1.error === null, String(w1.error))
const settingsFile = readdirSync(home).find(f => f.endsWith('.json'))
const read = (): Record<string, unknown> => JSON.parse(readFileSync(join(home, settingsFile!), 'utf8')) as Record<string, unknown>
const engineOf = (raw: Record<string, unknown>): Record<string, unknown> => (raw.engine ?? {}) as Record<string, unknown>
const raw1 = settingsFile ? read() : {}
t('settings file exists on disk', settingsFile !== undefined, readdirSync(home).join(','))
t('disk carries engine.effort max', engineOf(raw1).effort === 'max')
t('disk carries the one effort key and nothing beside it', [...Object.keys(raw1), ...Object.keys(engineOf(raw1))].filter(k => /effort|supercode/i.test(k)).join(',') === 'effort', JSON.stringify(raw1))
t('getInitialEffortSetting reads max back', effort.getInitialEffortSetting() === 'max')

console.log('— the /effort <level> shape —')
const w2 = settings.updateSettingsForSource('userSettings', {
  engine: { effort: 'xhigh' },
})
t('level write lands', w2.error === null, String(w2.error))
t('level persisted', engineOf(read()).effort === 'xhigh')

console.log('— the /effort auto shape clears the default —')
settings.updateSettingsForSource('userSettings', {
  engine: { effort: 'max' },
})
const w3 = settings.updateSettingsForSource('userSettings', {
  engine: { effort: undefined },
})
t('auto write lands', w3.error === null, String(w3.error))
t('auto deletes the key on disk', !('effort' in engineOf(read())))
t('getInitialEffortSetting reads auto (undefined)', effort.getInitialEffortSetting() === undefined)

console.log('— a stored word above the ladder degrades to absent (an earlier release wrote it; the schema no longer admits it) —')
const w4 = settings.updateSettingsForSource('userSettings', { engine: { effort: 'ultra' as never } })
t('a stored word off the ladder never reaches the boot read: the write is refused typed, or it lands and the read answers auto (undefined) — never the word, never a crash', w4.error !== null || effort.getInitialEffortSetting() === undefined, `error=${String(w4.error)} read=${String(effort.getInitialEffortSetting())}`)

console.log('— the wiring (command + boot seeds + chip stay honest) —')
const effortCmd = readFileSync('src/commands/effort/effort.tsx', 'utf8')
t('/effort <level> persists the default', /const persistable = toPersistableEffort\(level\) !== undefined[\s\S]{0,200}updateSettingsForSource\('userSettings', \{ engine: \{ effort: toPersistableEffort\(level\) \} \}\)/.test(effortCmd))
t('/effort auto clears the persisted default', /token === 'auto' \|\| token === 'unset'[\s\S]{0,200}engine: \{ effort: undefined \} \}\)/.test(effortCmd))
t('persisted level-sets SAY they saved (the /model mirror)', effortCmd.includes('saved as your default for future sessions'))
const main = readFileSync('src/main.tsx', 'utf8')
t('BOTH boot paths seed the effort default from the settings', (main.match(/\(opts\.effort as EffortLevel \| undefined\) \?\? getInitialSettings\(\)\.engine\?\.effort/g) ?? []).length === 2)
const schema = readFileSync('src/utils/settings/types.ts', 'utf8')
t('the settings schema takes its enum from the one ladder owner', schema.includes('effort: z.enum(EFFORT_LEVELS)'))
const frame = readFileSync('src/components/MercuryFrame.tsx', 'utf8')
t('the resolved-effort chip stays mounted in the statusbar', frame.includes('<EffortChip model={model} />'))
const slider = readFileSync('src/commands/effort/EffortSlider.tsx', 'utf8')
t('"Effort unchanged" carries the live level', slider.includes('Effort unchanged (${'))

console.log(failures ? '\n❌ EFFORT-PERSISTENCE RED' : '\n✅ EFFORT-PERSISTENCE GREEN')
process.exit(failures)
