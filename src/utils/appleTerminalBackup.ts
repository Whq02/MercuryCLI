import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'

/**
 * Backup and restore of macOS Terminal.app preferences around terminal
 * setup. The recovery state is carried across launches in two global-config
 * keys — `appleTerminalSetupInProgress` and `appleTerminalBackupPath` — read
 * by a later process, so their spellings are contract.
 */

const TERMINAL_DEFAULTS_DOMAIN = 'com.apple.Terminal'

/** The OS home, not the Mercury home. */
export function getTerminalPlistPath(): string {
  return join(homedir(), 'Library', 'Preferences', 'com.apple.Terminal.plist')
}

/** Record that terminal setup is in progress, with the backup location. */
export function markTerminalSetupInProgress(backupPath: string): void {
  saveGlobalConfig(currentConfig => ({
    ...currentConfig,
    appleTerminalSetupInProgress: true,
    appleTerminalBackupPath: backupPath,
  }))
}

/**
 * Lower the in-progress flag. The recorded backup path is deliberately left
 * in place.
 */
export function markTerminalSetupComplete(): void {
  saveGlobalConfig(currentConfig => ({
    ...currentConfig,
    appleTerminalSetupInProgress: false,
  }))
}

/**
 * Export the Terminal.app preferences and take a backup copy. Returns the
 * backup path, or null when the export failed or the plist never appeared.
 */
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
    // The backup export's exit status is deliberately not checked — a failed
    // backup export still records the in-progress state.
    await execFileNoThrow('defaults', ['export', TERMINAL_DEFAULTS_DOMAIN, backupPath])
    markTerminalSetupInProgress(backupPath)
    return backupPath
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * On launch: if a terminal setup was left in progress, import the recorded
 * backup back into Terminal.app. An import failure leaves the in-progress
 * flag set so a later launch retries; success (and every no-backup case)
 * clears it.
 */
export async function checkAndRestoreTerminalBackup(): Promise<
  { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string }
> {
  let backupPath = ''
  try {
    const config = getGlobalConfig()
    const inProgress = config.appleTerminalSetupInProgress ?? false
    // An empty recorded path is treated as absent.
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
      // Deliberately leave the in-progress flag raised so a later launch
      // retries the restore.
      return { status: 'failed', backupPath }
    }
    // Kill the preferences daemon so the restored values take effect.
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return { status: 'restored' }
  } catch (err) {
    logError(err)
    markTerminalSetupComplete()
    return { status: 'failed', backupPath }
  }
}
