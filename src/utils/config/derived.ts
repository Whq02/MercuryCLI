import { join } from 'path'
import { getOriginalCwd, getSessionPermissionModeResolution } from '../../bootstrap/state.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { SessionPermissionModeResolution } from '../permissions/permissionSetup.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  getMercuryHome,
  isEnvDefinedFalsy,
  } from '../envUtils.js'
import type { MemoryType } from '../memory/types.js'
import { getManagedFilePath } from '../settings/managedPath.js'

import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfigDeferred } from './globalConfig.js'
import { notBuilt } from '../../pi/holes.js'

export function getRemoteControlAtStartup(): boolean {
  return notBuilt('src/utils/config/derived.ts:15')
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  return notBuilt('src/utils/config/derived.ts:22')
}

export function binaryName(): string {
  return notBuilt('src/utils/config/derived.ts:31')
}

export function isCopyOnSelectEnabled(): boolean {
  return notBuilt('src/utils/config/derived.ts:35')
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
  return notBuilt('src/utils/config/derived.ts:49')
}

export function getMemoryPath(memoryType: MemoryType): string {
  return notBuilt('src/utils/config/derived.ts:65')
}

export function getManagedRulesDir(): string {
  return notBuilt('src/utils/config/derived.ts:69')
}

export function getUserRulesDir(): string {
  return notBuilt('src/utils/config/derived.ts:73')
}

export function getEffectivePermissionMode(sessionMode: PermissionMode): SessionPermissionModeResolution {
  const birth = getSessionPermissionModeResolution()
  return birth?.mode === sessionMode
    ? { ...birth }
    : { mode: sessionMode, source: 'session-choice' }
}
