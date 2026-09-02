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
  JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], defaultMode: 'default' }, spinnerTipsEnabled: true }, null, 2),
)

{
  const { error } = settings.updateSettingsForSource('userSettings', { permissions: { defaultMode: 'plan' } } as never)
  t('§1 the scoped write lands', error === null, String(error))
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { permissions?: Record<string, unknown>; spinnerTipsEnabled?: boolean }
  t('§1 …changing defaultMode', disk.permissions?.defaultMode === 'plan')
  t('§1 …with the sibling allow rule untouched', JSON.stringify(disk.permissions?.allow) === JSON.stringify(['Bash(ls:*)']))
  t('§1 …and unrelated keys untouched', disk.spinnerTipsEnabled === true)
}

{
  const { error } = settings.updateSettingsForSource('userSettings', { permissions: { defaultMode: undefined } } as never)
  t('§1 the explicit-undefined write lands', error === null, String(error))
  const disk = JSON.parse(readFileSync(FILE, 'utf8')) as { permissions?: Record<string, unknown> }
  t('§1 …deleting defaultMode from disk (the revert can finally clear it)', !('defaultMode' in (disk.permissions ?? {})))
  t('§1 …with the sibling allow rule still standing', JSON.stringify(disk.permissions?.allow) === JSON.stringify(['Bash(ls:*)']))
}

{
  const config = readFileSync(join(import.meta.dir, '../../src/components/Settings/Config.tsx'), 'utf8')
  t('§2 the mode toggle writes ONLY the changed key', config.includes('permissions: { defaultMode: next }'))
  t('§2 …never the merged spread', !config.includes('...(merged.permissions ?? {}), defaultMode'))
  t('§2 the revert passes the explicit-undefined delete shape', config.includes('permissions: { defaultMode: snapshots.user.permissions?.defaultMode }'))
  t("§2 …never a local-object delete the merge cannot see", !config.includes("delete merged['defaultMode']"))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'SETTINGS WRITE SCOPE: ALL PASS' : 'SETTINGS WRITE SCOPE: RED')
process.exit(failures)
