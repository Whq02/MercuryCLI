import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'


const TERMINAL_DEFAULTS_DOMAIN = 'com.apple.Terminal'

export function getTerminalPlistPath(): string {
  return join(homedir(), 'Library', 'Preferences', 'com.apple.Terminal.plist')
}

export function markTerminalSetupInProgress(backupPath: string): void {
  saveGlobalConfig(currentConfig => ({
    ...currentConfig,
    appleTerminalSetupInProgress: true,
    appleTerminalBackupPath: backupPath,
  }))
}

export function markTerminalSetupComplete(): void {
  saveGlobalConfig(currentConfig => ({
    ...currentConfig,
    appleTerminalSetupInProgress: false,
  }))
}

export async function backupTerminalPreferences(): Promise<string | null> {
  try {
    const plistPath = getTerminalPlistPath()
    const exportResult = await execFileNoThrow('defaults', [
      'export',
      TERMINAL_DEFAULTS_DOMAIN,
      plistPath,
    ])
    if (exportResult.code !== 0) return null
    if (!existsSync(plistPath)) return null
    const backupPath = `${plistPath}.bak`
    await execFileNoThrow('defaults', ['export', TERMINAL_DEFAULTS_DOMAIN, backupPath])
    markTerminalSetupInProgress(backupPath)
    return backupPath
  } catch (err) {
    logError(err)
    return null
  }
}

export async function checkAndRestoreTerminalBackup(): Promise<
  { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string }
> {
  let backupPath = ''
  try {
    const config = getGlobalConfig()
    const inProgress = config.appleTerminalSetupInProgress ?? false
    backupPath = config.appleTerminalBackupPath || ''
    if (!inProgress) return { status: 'no_backup' }
    if (!backupPath) {
      markTerminalSetupComplete()
      return { status: 'no_backup' }
    }
    if (!existsSync(backupPath)) {
      markTerminalSetupComplete()
      return { status: 'no_backup' }
    }
    const importResult = await execFileNoThrow('defaults', [
      'import',
      TERMINAL_DEFAULTS_DOMAIN,
      backupPath,
    ])
    if (importResult.code !== 0) {
      return { status: 'failed', backupPath }
    }
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return { status: 'restored' }
  } catch (err) {
    logError(err)
    markTerminalSetupComplete()
    return { status: 'failed', backupPath }
  }
}
