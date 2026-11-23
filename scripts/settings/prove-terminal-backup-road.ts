#!/usr/bin/env bun
// gate-watch: src/commands/keysetup/appleTerminalBackup.ts
import { mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-backup-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)
const terminalBackupHint = 'see src/commands/keysetup/appleTerminalBackup.ts'

const calls: string[][] = []
let exportCode = 0
let importCode = 0
let plistAppears = true
mkdirSync(join(HOME, 'Library', 'Preferences'), { recursive: true })
const execActual = await import('../../src/platform/processes/execFileNoThrow.ts')
mock.module('../../src/platform/processes/execFileNoThrow.ts', () => ({
  ...execActual,
  execFileNoThrow: async (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file === 'defaults' && args[0] === 'export') {
      if (exportCode === 0 && plistAppears) writeFileSync(args[2]!, 'plist')
      return { code: exportCode, stdout: '', stderr: '' }
    }
    if (file === 'defaults' && args[0] === 'import') return { code: importCode, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  },
}))
const osActual = await import('node:os')
mock.module('node:os', () => ({ ...osActual, homedir: () => HOME }))

const { enableConfigs, getGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const backup = await import('../../src/commands/keysetup/appleTerminalBackup.ts')
const flags = () => ({ inProgress: getGlobalConfig().appleTerminalSetupInProgress, path: getGlobalConfig().appleTerminalBackupPath })

section('§1 nothing in progress: the launch check is a no-op')
{
  check('the plist path is under the OS home', backup.getTerminalPlistPath() === join(HOME, 'Library', 'Preferences', 'com.apple.Terminal.plist'), `${terminalBackupHint}: getTerminalPlistPath must build the path from the OS home`)
  const outcome = await backup.checkAndRestoreTerminalBackup()
  check('no backup, no process started', outcome.status === 'no_backup' && calls.length === 0, `${j(outcome)}; ${terminalBackupHint}: checkAndRestoreTerminalBackup must return no_backup without running a process when no setup is in progress`)
}

section('§2 the backup export records the in-progress state with the backup path')
{
  const path = await backup.backupTerminalPreferences()
  check('the backup is the plist beside a .bak suffix', path === `${backup.getTerminalPlistPath()}.bak`, `${String(path)}; ${terminalBackupHint}: backupTerminalPreferences must return the plist path with a .bak suffix`)
  check('two exports ran: the plist, then the backup', j(calls.map(c => c.join(' '))) === j([`defaults export com.apple.Terminal ${backup.getTerminalPlistPath()}`, `defaults export com.apple.Terminal ${path}`]), `${j(calls)}; ${terminalBackupHint}: backupTerminalPreferences must run defaults export for the plist, then for the backup`)
  check('the config records the in-progress flag and the path', flags().inProgress === true && flags().path === path, `${j(flags())}; ${terminalBackupHint}: backupTerminalPreferences must record appleTerminalSetupInProgress and appleTerminalBackupPath in the global config`)
  backup.markTerminalSetupComplete()
  check('completing lowers the flag and keeps the path', flags().inProgress === false && flags().path === path, `${j(flags())}; ${terminalBackupHint}: markTerminalSetupComplete must lower the in-progress flag and keep the backup path`)
  calls.length = 0
  exportCode = 1
  check('a failed export answers null and records nothing new', (await backup.backupTerminalPreferences()) === null && calls.length === 1 && flags().inProgress === false, `calls: ${j(calls)}, flags: ${j(flags())}; ${terminalBackupHint}: backupTerminalPreferences must return null on a failed export and not raise the flag`)
  exportCode = 0
  plistAppears = false
  rmSync(backup.getTerminalPlistPath(), { force: true })
  check('an export after which the plist never appeared answers null', (await backup.backupTerminalPreferences()) === null, `${terminalBackupHint}: backupTerminalPreferences must return null when the plist file is absent after the export`)
  plistAppears = true
}

section('§3 the launch restore: missing backup, failed import, successful import')
{
  const path = await backup.backupTerminalPreferences()
  rmSync(path!, { force: true })
  calls.length = 0
  let outcome = await backup.checkAndRestoreTerminalBackup()
  check('an in-progress record whose backup file is gone answers no_backup and lowers the flag', outcome.status === 'no_backup' && flags().inProgress === false && calls.length === 0, `${j(outcome)}; ${terminalBackupHint}: checkAndRestoreTerminalBackup must answer no_backup, lower the flag and run no process when the backup file is gone`)
  await backup.backupTerminalPreferences()
  calls.length = 0
  importCode = 1
  outcome = await backup.checkAndRestoreTerminalBackup()
  check('a failed import answers failed with the path and leaves the flag raised for the next launch', outcome.status === 'failed' && (outcome as { backupPath: string }).backupPath === path && flags().inProgress === true, `${j(outcome)}; ${terminalBackupHint}: checkAndRestoreTerminalBackup must answer failed with backupPath and keep the flag raised when defaults import fails`)
  check('no preferences daemon was killed on a failed import', !calls.some(c => c[0] === 'killall'), `${j(calls)}; ${terminalBackupHint}: checkAndRestoreTerminalBackup must restart the preferences daemon only after a successful import`)
  importCode = 0
  calls.length = 0
  outcome = await backup.checkAndRestoreTerminalBackup()
  check('a successful import answers restored, kills cfprefsd and lowers the flag', outcome.status === 'restored' && j(calls.map(c => c.join(' '))) === j([`defaults import com.apple.Terminal ${path}`, 'killall cfprefsd']) && flags().inProgress === false, `${j(calls)}; ${terminalBackupHint}: checkAndRestoreTerminalBackup must run defaults import, then restart the preferences daemon, then lower the flag`)
  check('the backup file is left in place', existsSync(path!), `${terminalBackupHint}: checkAndRestoreTerminalBackup must not delete the backup file`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-terminal-backup-road: ALL PASS' : `\nprove-terminal-backup-road: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
