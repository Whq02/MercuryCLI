#!/usr/bin/env bun
// ============================================================================
//  prove-corrupt-config-backup-road — the corrupt-config gate names the
//  newest backup and offers a non-destructive restore (release-hardening
//  audit rank 65).
//
//  The gap: when the global config failed JSON.parse at the boot gate — a
//  hand-edit typo, a torn write from a killed process, a half-synced roaming
//  profile — the dialog offered exactly two paths: exit and fix by hand, or
//  reset to defaults, which discards the signed-in account record, the
//  onboarding mark, every per-project trust grant and every project record.
//  Up to five timestamped good copies of that same file sat under the
//  backup home, put there by the save path for precisely this case, and
//  neither the dialog nor the non-interactive stderr line named one: the
//  throwOnInvalid early return fired before the recovery-messaging block
//  that consults findMostRecentBackup.
//
//    L1 the backup finder is exported and answers the newest copy
//    L2 the restore road: the corrupt bytes are quarantined, the backup's
//       bytes replace the file
//    L3 the dialog offers the restore as its first option, names the copy,
//       and warns what the reset discards (source pins)
//    L4 the non-interactive arm prints the pointer and the cp line
//       (source pin)
//
//  Hermetic scratch home. PROVE_SRC names another checkout's src (the A/B
//  control: red at the pre-fix tree — no export, no road).
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'corrupt-config-backup-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const config = await import(join(SRC, 'utils/config/globalConfig.ts'))
const backupDir = config.getConfigBackupDir() as string
const file = join(HOME, '.mercury.json')
const GOOD_OLD = '{"numStartups":3,"hasCompletedOnboarding":true}\n'
const GOOD_NEW = '{"numStartups":4,"hasCompletedOnboarding":true,"projects":{"/w":{"hasTrustDialogAccepted":true}}}\n'
const CORRUPT = '{"numStartups":5,\n'
mkdirSync(backupDir, { recursive: true })
writeFileSync(join(backupDir, '.mercury.json.backup.1000'), GOOD_OLD)
writeFileSync(join(backupDir, '.mercury.json.backup.2000'), GOOD_NEW)
writeFileSync(file, CORRUPT)

console.log('L1 the backup finder')
const find = config.findMostRecentBackup as ((f: string) => string | null) | undefined
check('findMostRecentBackup is exported', typeof find === 'function')
const newest = find?.(file) ?? null
check('it answers the newest timestamped copy', newest === join(backupDir, '.mercury.json.backup.2000'), String(newest))

console.log('L2 the restore road')
{
  const restore = config.restoreConfigFromBackup as ((f: string, b: string) => { quarantinePath: string | null }) | undefined
  check('restoreConfigFromBackup is exported', typeof restore === 'function')
  const receipt = newest !== null ? restore?.(file, newest) : undefined
  check("the file now holds the backup's bytes", readFileSync(file, 'utf8') === GOOD_NEW, readFileSync(file, 'utf8'))
  const quarantine = receipt?.quarantinePath ?? null
  check('the corrupt bytes were quarantined under the backup home', quarantine !== null && existsSync(quarantine) && readFileSync(quarantine, 'utf8') === CORRUPT, String(quarantine))
  check('the quarantine name says which road kept it', /\.corrupted\.restore-\d+$/.test(quarantine ?? ''), String(quarantine))
  check('the backups themselves are untouched', readdirSync(backupDir).filter(f => f.includes('.backup.')).length === 2)
}

console.log('L3 the dialog (source pins)')
{
  const dialog = readFileSync(join(SRC, 'components/InvalidConfigDialog.tsx'), 'utf8')
  check('the dialog looks the newest backup up', dialog.includes('findMostRecentBackup(error.filePath)'))
  check('it offers the restore as the FIRST option, naming the copy', /Restore the newest backup \(\$\{basename\(backupPath\)\}\)/.test(dialog) && dialog.indexOf("value: 'restore'") < dialog.indexOf("value: 'exit'"))
  check('the restore rides the one road and exits 0 with a notice', dialog.includes('restoreConfigFromBackup(error.filePath, backupPath)') && dialog.includes('the configuration was restored from'))
  check('the reset option warns what it discards', dialog.includes('discards account, trust grants, project records'))
  check('the copy is named in the dialog text', dialog.includes('The newest good copy is at'))
}

console.log('L4 the non-interactive arm (source pin)')
{
  const init = readFileSync(join(SRC, 'entrypoints/init.ts'), 'utf8')
  const arm = init.slice(init.indexOf('if (error instanceof ConfigParseError)'), init.indexOf('if (error instanceof ConfigParseError)') + 1200)
  check('the headless arm looks the backup up', arm.includes('findMostRecentBackup(error.filePath)'))
  check('and prints the pointer and the cp line', arm.includes('A backup file exists at:') && arm.includes('You can restore it by running: cp'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-corrupt-config-backup-road: ALL PASS' : `\nprove-corrupt-config-backup-road: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
