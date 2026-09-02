#!/usr/bin/env bun
// ============================================================================
//  prove-effort-persistence — task #11's persisted effort default.
//
//  AVS friction audit: supercode was session-only BY DESIGN and
//  'max' was filtered out of persistence — the operator re-armed effort three
//  times in one audited day (every restart lost the session posture, plus two
//  "Effort unchanged" polling visits). The fix: 'max' joins the persistable
//  ladder, /effort supercode saves a persisted default (supercodeEffort), the
//  boot seeds arm it, and /effort <level> · /effort auto clear it (mutual
//  exclusion).
//
//  Hermetic: MERCURY_CONFIG_DIR is a temp dir; effort env is scrubbed; modules
//  are dynamically imported AFTER the env pin. Writes go through the REAL
//  updateSettingsForSource (which resets the settings cache, so each read is
//  a fresh-from-disk read — the same shape as a restart).
// ============================================================================
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
t("toPersistableEffort('max') persists (the task-#11 flip)", effort.toPersistableEffort('max') === 'max')
t("toPersistableEffort('xhigh') still persists", effort.toPersistableEffort('xhigh') === 'xhigh')
t('numeric (ant-only) values never persist', effort.toPersistableEffort(3) === undefined)
t('undefined stays undefined', effort.toPersistableEffort(undefined) === undefined)

console.log('— the supercode default round-trip (write → disk → boot read) —')
const w1 = settings.updateSettingsForSource('userSettings', {
  effortLevel: 'max',
  supercodeEffort: true,
})
t('supercode-default write lands', w1.error === null, String(w1.error))
// The file is REALLY on disk (not just a cache): discover + read it raw.
const settingsFile = readdirSync(home).find(f => f.endsWith('.json'))
const raw1 = settingsFile
  ? (JSON.parse(readFileSync(join(home, settingsFile), 'utf8')) as Record<string, unknown>)
  : {}
t('settings file exists on disk', settingsFile !== undefined, readdirSync(home).join(','))
t('disk carries effortLevel max', raw1.effortLevel === 'max')
t('disk carries supercodeEffort true', raw1.supercodeEffort === true)
// Fresh-from-disk read (updateSettingsForSource reset the cache) — the same
// read the boot seeds perform.
t('getInitialEffortSetting reads max back', effort.getInitialEffortSetting() === 'max')
t('getInitialSupercodeSetting arms', effort.getInitialSupercodeSetting() === true)

console.log('— mutual exclusion (the /effort <level> shape) —')
const w2 = settings.updateSettingsForSource('userSettings', {
  effortLevel: 'xhigh',
  supercodeEffort: undefined,
})
t('level write lands', w2.error === null, String(w2.error))
const raw2 = JSON.parse(readFileSync(join(home, settingsFile!), 'utf8')) as Record<string, unknown>
t('explicit level DELETES the supercode default on disk', !('supercodeEffort' in raw2))
t('level persisted', raw2.effortLevel === 'xhigh')
t('getInitialSupercodeSetting disarms', effort.getInitialSupercodeSetting() === false)

console.log('— the /effort auto shape clears both —')
settings.updateSettingsForSource('userSettings', {
  effortLevel: 'max',
  supercodeEffort: true,
})
const w3 = settings.updateSettingsForSource('userSettings', {
  effortLevel: undefined,
  supercodeEffort: undefined,
})
t('auto write lands', w3.error === null, String(w3.error))
const raw3 = JSON.parse(readFileSync(join(home, settingsFile!), 'utf8')) as Record<string, unknown>
t('auto deletes both keys on disk', !('effortLevel' in raw3) && !('supercodeEffort' in raw3))
t('getInitialEffortSetting reads auto (undefined)', effort.getInitialEffortSetting() === undefined)

console.log('— the wiring (command + boot seeds + chip stay honest) —')
const effortCmd = readFileSync('src/commands/effort/effort.tsx', 'utf8')
t('/effort supercode PERSISTS the default', /updateSettingsForSource\('userSettings', \{\s*effortLevel: 'max',\s*supercodeEffort: true/.test(effortCmd))
t('/effort supercode says it saved', effortCmd.includes('SUPERCODE is on, and persists as your default for new sessions'))
t('/effort <level> clears the persisted default', /const persistable = toPersistableEffort\(level\) !== undefined[\s\S]{0,400}supercodeEffort: undefined/.test(effortCmd))
t('/effort auto clears the persisted default', /token === 'auto' \|\| token === 'unset'[\s\S]{0,300}supercodeEffort: undefined/.test(effortCmd))
t('persisted level-sets SAY they saved (the /model mirror)', effortCmd.includes('saved as your default for future sessions'))
const main = readFileSync('src/main.tsx', 'utf8')
t('BOTH boot paths seed the supercode default', (main.match(/Boolean\(getInitialSettings\(\)\.supercodeEffort\)/g) ?? []).length === 2)
t('an explicit --effort suppresses the boot arm (mutual exclusion)', /opts\.effort === undefined && Boolean\(getInitialSettings\(\)\.supercodeEffort\)/.test(main))
const schema = readFileSync('src/utils/settings/types.ts', 'utf8')
t("settings schema accepts 'max' at runtime", /effortLevel:[\s\S]{0,400}'max'\],?\s*\)/.test(schema))
t('settings schema carries supercodeEffort', schema.includes('supercodeEffort: z'))
const frame = readFileSync('src/components/MercuryFrame.tsx', 'utf8')
t('the resolved-effort chip stays mounted in the statusbar', frame.includes('<EffortChip model={model} />'))
const slider = readFileSync('src/commands/effort/EffortSlider.tsx', 'utf8')
t('"Effort unchanged" now carries the live level', slider.includes('Effort unchanged (${'))

console.log(failures ? '\n❌ EFFORT-PERSISTENCE RED' : '\n✅ EFFORT-PERSISTENCE GREEN')
process.exit(failures)
