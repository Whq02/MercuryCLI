import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'

const TERMINAL_DEFAULTS_DOMAIN = 'com.apple.Terminal'

type RestoreOutcome = { status: 'restored' | 'no_backup' } | { status: 'failed'; backupPath: string }

export function getTerminalPlistPath(): string {
  return join(homedir(), 'Library', 'Preferences', 'com.apple.Terminal.plist')
}

const defaults = (verb: 'export' | 'import', path: string): Promise<{ code: number }> =>
  execFileNoThrow('defaults', [verb, TERMINAL_DEFAULTS_DOMAIN, path])

const recordSetup = (inProgress: boolean, backupPath?: string): void =>
  saveGlobalConfig(current => ({
    ...current,
    appleTerminalSetupInProgress: inProgress,
    ...(backupPath === undefined ? {} : { appleTerminalBackupPath: backupPath }),
  }))

export function markTerminalSetupComplete(): void {
  recordSetup(false)
}

export async function backupTerminalPreferences(): Promise<string | null> {
  try {
    const plistPath = getTerminalPlistPath()
    const exported = await defaults('export', plistPath)
    if (exported.code !== 0 || !existsSync(plistPath)) return null
    const backupPath = `${plistPath}.bak`
    await defaults('export', backupPath)
    recordSetup(true, backupPath)
    return backupPath
  } catch (err) {
    logError(err)
    return null
  }
}

const pendingBackupPath = (): string | null => {
  const { appleTerminalSetupInProgress, appleTerminalBackupPath } = getGlobalConfig()
  return appleTerminalSetupInProgress ? appleTerminalBackupPath || '' : null
}

export async function checkAndRestoreTerminalBackup(): Promise<RestoreOutcome> {
  let backupPath = ''
  try {
    const pending = pendingBackupPath()
    if (pending === null) return { status: 'no_backup' }
    backupPath = pending
    if (!backupPath || !existsSync(backupPath)) {
      markTerminalSetupComplete()
      return { status: 'no_backup' }
    }
    const imported = await defaults('import', backupPath)
    if (imported.code !== 0) return { status: 'failed', backupPath }
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return { status: 'restored' }
  } catch (err) {
    logError(err)
    markTerminalSetupComplete()
    return { status: 'failed', backupPath }
  }
}
