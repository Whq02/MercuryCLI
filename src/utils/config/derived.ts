import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import {
  getMercuryHome,
  isEnvDefinedFalsy,
  } from '../envUtils.js'
import type { MemoryType } from '../memory/types.js'
import { getManagedFilePath } from '../settings/managedPath.js'

import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfigDeferred } from './globalConfig.js'

export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit

  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const responses = getGlobalConfig().customApiKeyResponses
  if (responses?.approved?.includes(truncatedApiKey)) return 'approved'
  if (responses?.rejected?.includes(truncatedApiKey)) return 'rejected'
  return 'new'
}

export function binaryName(): string {
  return 'mercury'
}

export function isCopyOnSelectEnabled(): boolean {
  return getGlobalConfig().copyOnSelect ?? true
}

export function isMouseCaptureEnabled(): boolean {
  if (!isConfigReadingAllowed()) return true
  return getGlobalConfig().mouseCapture !== false
}

export function isMercurySubstrateProfileOn(): boolean {
  if (isEnvDefinedFalsy(flagEnv('MERCURY_SUBSTRATE'))) return false
  return true
}

export function recordFirstStartTime(): void {
  if (getGlobalConfig().firstStartTime) return
  const firstStartTime = new Date().toISOString()
  saveGlobalConfigDeferred(current => ({
    ...current,
    firstStartTime: current.firstStartTime ?? firstStartTime,
  }))
}

const MEMORY_HOME_FILE: Record<MemoryType, (cwd: string) => string> = {
  User: () => join(getMercuryHome(), 'MERCURY.md'),
  Local: cwd => join(cwd, 'MERCURY.local.md'),
  Project: cwd => join(cwd, 'MERCURY.md'),
  Managed: () => join(getManagedFilePath(), 'MERCURY.md'),
}

export function getMemoryPath(memoryType: MemoryType): string {
  return MEMORY_HOME_FILE[memoryType](getOriginalCwd())
}

export function getManagedRulesDir(): string {
  return join(getManagedFilePath(), '.mercury', 'rules')
}

export function getUserRulesDir(): string {
  return join(getMercuryHome(), 'rules')
}
