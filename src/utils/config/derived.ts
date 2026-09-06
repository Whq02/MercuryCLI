import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../../memdir/paths.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import {
  getMercuryHome,
  isEnvDefinedFalsy,
  } from '../envUtils.js'
import type { MemoryType } from '../memory/types.js'
import { getManagedFilePath } from '../settings/managedPath.js'

import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from './globalConfig.js'

export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit

  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
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
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getMercuryHome(), 'MERCURY.md')
    case 'Local':
      return join(cwd, 'MERCURY.local.md')
    case 'Project':
      return join(cwd, 'MERCURY.md')
    case 'Managed':
      return join(getManagedFilePath(), 'MERCURY.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  return ''
}

export function getManagedRulesDir(): string {
  return join(getManagedFilePath(), '.mercury', 'rules')
}

export function getUserRulesDir(): string {
  return join(getMercuryHome(), 'rules')
}
