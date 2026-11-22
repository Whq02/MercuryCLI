import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'

const TERMINAL_DEFAULTS_DOMAIN = 'com.apple.Terminal'

type RestoreOutcome = { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string }

export function getTerminalPlistPath(): string {
  return join(homedir(), 'Library', 'Preferences', `${TERMINAL_DEFAULTS_DOMAIN}.plist`)
}

export function markTerminalSetupComplete(): void {
  saveGlobalConfig(config => ({ ...config, appleTerminalSetupInProgress: false }))
}

function runDefaults(verb: 'export' | 'import', path: string) {
  return execFileNoThrow('defaults', [verb, TERMINAL_DEFAULTS_DOMAIN, path])
}
export async function backupTerminalPreferences(): Promise<string | null> {
  try {
    const path = getTerminalPlistPath()
    if ((await runDefaults('export', path)).code !== 0 || !existsSync(path)) return null
    const backupPath = path + '.bak'
    await runDefaults('export', backupPath)
    saveGlobalConfig(config => ({ ...config, appleTerminalSetupInProgress: true, appleTerminalBackupPath: backupPath }))
    return backupPath
  } catch (error) {
    logError(error)
    return null
  }
}

const pendingBackupPath = (): string | null => {
  const { appleTerminalSetupInProgress, appleTerminalBackupPath } = getGlobalConfig()
  return appleTerminalSetupInProgress ? appleTerminalBackupPath || '' : null
}

export async function checkAndRestoreTerminalBackup(): Promise<RestoreOutcome> {
  let backupPath: string | null = null
  try {
    backupPath = pendingBackupPath()
    if (backupPath === null) return { status: 'no_backup' }
    if (!backupPath || !existsSync(backupPath)) {
      markTerminalSetupComplete()
      return { status: 'no_backup' }
    }
    if ((await runDefaults('import', backupPath)).code !== 0) return { status: 'failed', backupPath }
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return { status: 'restored' }
  } catch (error) {
    logError(error)
    markTerminalSetupComplete()
    return { status: 'failed', backupPath: backupPath ?? '' }
  }
}
