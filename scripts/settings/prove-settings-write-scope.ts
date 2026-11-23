#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'settings-scope-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME

const settings = await import('../../src/platform/settings/settings.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const FILE = join(HOME, 'settings.json')
writeFileSync(
  FILE,
  JSON.stringify({ guardrails: { allow: ['Bash(ls *)'], mode: 'default' }, activity: { tips: { enabled: true } } }, null, 2),
)

{
  const { error } = settings.updateSettingsForSource('userSettings', { guardrails: { mode: 'implement' } })
  t('§1 the scoped write lands', error === null, `${String(error)}; updateSettingsForSource in src/platform/settings/settings.ts must write the userSettings file without an error`)
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { guardrails?: Record<string, unknown>; activity?: { tips?: { enabled?: boolean } } }
  t('§1 …changing mode', disk.guardrails?.mode === 'implement', 'updateSettingsForSource in src/platform/settings/settings.ts must write the changed key to settings.json')
  t('§1 …with the sibling allow rule untouched', JSON.stringify(disk.guardrails?.allow) === JSON.stringify(['Bash(ls *)']), 'updateSettingsForSource in src/platform/settings/settings.ts must merge into the guardrails object, not replace it')
  t('§1 …and unrelated keys untouched', disk.activity?.tips?.enabled === true, 'updateSettingsForSource in src/platform/settings/settings.ts must leave keys outside the update as they were')
}

{
  const { error } = settings.updateSettingsForSource('userSettings', { guardrails: { mode: undefined } })
  t('§1 the explicit-undefined write lands', error === null, `${String(error)}; updateSettingsForSource in src/platform/settings/settings.ts must accept an explicit undefined value without an error`)
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { guardrails?: Record<string, unknown> }
  t('§1 …deleting mode from disk (the revert can finally clear it)', !('mode' in (disk.guardrails ?? {})), 'updateSettingsForSource in src/platform/settings/settings.ts must delete a key whose update value is undefined')
  t('§1 …with the sibling allow rule still standing', JSON.stringify(disk.guardrails?.allow) === JSON.stringify(['Bash(ls *)']), 'updateSettingsForSource in src/platform/settings/settings.ts must delete only the undefined key and keep its siblings')
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'SETTINGS WRITE SCOPE: ALL PASS' : 'SETTINGS WRITE SCOPE: RED')
process.exit(failures)
