import { copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logError } from './log.js'


export type RestoreResult = { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string }

const ITERM2_PREFERENCES_PATH = join(homedir(), 'Library', 'Preferences', 'com.googlecode.iterm2.plist')

export function markITerm2SetupComplete(): void {
  saveGlobalConfig(config => ({ ...config, iterm2SetupInProgress: false }))
}

export async function checkAndRestoreITerm2Backup(): Promise<RestoreResult> {
  const config = getGlobalConfig()
  if (!config.iterm2SetupInProgress) return { status: 'no_backup' }
  const backupPath = config.iterm2BackupPath
  if (!backupPath) {
    markITerm2SetupComplete()
    return { status: 'no_backup' }
  }
  if (!existsSync(backupPath)) {
    markITerm2SetupComplete()
    return { status: 'no_backup' }
  }
  try {
    copyFileSync(backupPath, ITERM2_PREFERENCES_PATH)
    markITerm2SetupComplete()
    return { status: 'restored' }
  } catch (err) {
    logError(new Error(`Failed to restore the iTerm2 preferences backup from ${backupPath}: ${String(err)}`))
    markITerm2SetupComplete()
    return { status: 'failed', backupPath }
  }
}
