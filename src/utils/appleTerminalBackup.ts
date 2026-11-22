import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'
import { notBuilt } from '../pi/holes.js'

const TERMINAL_DEFAULTS_DOMAIN = 'com.apple.Terminal'

type RestoreOutcome = { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string }

export function getTerminalPlistPath(): string {
  return notBuilt('src/utils/appleTerminalBackup.ts:13')
}

export function markTerminalSetupComplete(): void {
  return notBuilt('src/utils/appleTerminalBackup.ts:27')
}

export async function backupTerminalPreferences(): Promise<string | null> {
  return notBuilt('src/utils/appleTerminalBackup.ts:31')
}

const pendingBackupPath = (): string | null => {
  const { appleTerminalSetupInProgress, appleTerminalBackupPath } = getGlobalConfig()
  return appleTerminalSetupInProgress ? appleTerminalBackupPath || '' : null
}

export async function checkAndRestoreTerminalBackup(): Promise<RestoreOutcome> {
  return notBuilt('src/utils/appleTerminalBackup.ts:51')
}
