#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'corrupt-config-backup-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const BACKUP_FAILURE_HINT =
  'fix findMostRecentBackup or restoreConfigFromBackup in src/platform/config/globalConfig.ts, whichever this check names'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail}; ` : ''}${BACKUP_FAILURE_HINT}` : ''}`)
}

const config = await import(join(SRC, 'platform/config/globalConfig.ts'))
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
  const backups = readdirSync(backupDir).filter(f => f.includes('.backup.')).sort()
  check('the backups themselves are untouched', backups.length === 2)
  check('…by identity: exactly .backup.1000 and .backup.2000 remain', backups.join(',') === '.mercury.json.backup.1000,.mercury.json.backup.2000', backups.join(','))
  check('…and by content: the older copy still holds GOOD_OLD, the restored copy still holds GOOD_NEW', readFileSync(join(backupDir, '.mercury.json.backup.1000'), 'utf8') === GOOD_OLD && readFileSync(join(backupDir, '.mercury.json.backup.2000'), 'utf8') === GOOD_NEW)
}


rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-corrupt-config-backup-road: ALL PASS' : `\nprove-corrupt-config-backup-road: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
