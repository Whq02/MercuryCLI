#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'settings-scope-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME

const settings = await import('../../src/utils/settings/settings.ts')

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
  t('§1 the scoped write lands', error === null, String(error))
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { guardrails?: Record<string, unknown>; activity?: { tips?: { enabled?: boolean } } }
  t('§1 …changing mode', disk.guardrails?.mode === 'implement')
  t('§1 …with the sibling allow rule untouched', JSON.stringify(disk.guardrails?.allow) === JSON.stringify(['Bash(ls *)']))
  t('§1 …and unrelated keys untouched', disk.activity?.tips?.enabled === true)
}

{
  const { error } = settings.updateSettingsForSource('userSettings', { guardrails: { mode: undefined } })
  t('§1 the explicit-undefined write lands', error === null, String(error))
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { guardrails?: Record<string, unknown> }
  t('§1 …deleting mode from disk (the revert can finally clear it)', !('mode' in (disk.guardrails ?? {})))
  t('§1 …with the sibling allow rule still standing', JSON.stringify(disk.guardrails?.allow) === JSON.stringify(['Bash(ls *)']))
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'SETTINGS WRITE SCOPE: ALL PASS' : 'SETTINGS WRITE SCOPE: RED')
process.exit(failures)
