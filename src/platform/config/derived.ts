import { join } from 'path'
import { getOriginalCwd, getSessionPermissionModeResolution } from '../../boot/process-state/processState.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import type { SessionPermissionModeResolution } from '../../permissions/rules/permissionSetup.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  getMercuryHome,
  isEnvDefinedFalsy,
  } from '../environment/envUtils.js'
import type { InstructionFileType } from '../../sessions/memory-shapes/types.js'
import { getManagedFilePath } from '../settings/managedPath.js'

import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfigDeferred } from './globalConfig.js'

export function getRemoteControlAtStartup(): boolean {
  const saved = getGlobalConfig().remoteControlAtStartup
  return saved !== undefined ? saved : false
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
  saveGlobalConfigDeferred(current => ({ ...current, firstStartTime: current.firstStartTime ?? firstStartTime }))
}

const INSTRUCTION_HOME_FILE: Record<InstructionFileType, (originalCwd: string) => string> = {
  User: () => join(getMercuryHome(), 'MERCURY.md'),
  Local: originalCwd => join(originalCwd, 'MERCURY.local.md'),
  Project: originalCwd => join(originalCwd, 'MERCURY.md'),
  Managed: () => join(getManagedFilePath(), 'MERCURY.md'),
}

export function getInstructionFilePath(memoryType: InstructionFileType): string {
  return INSTRUCTION_HOME_FILE[memoryType](getOriginalCwd())
}

export function getManagedRulesDir(): string {
  return join(getManagedFilePath(), '.mercury', 'rules')
}

export function getUserRulesDir(): string {
  return join(getMercuryHome(), 'rules')
}

export function getEffectivePermissionMode(sessionMode: PermissionMode): SessionPermissionModeResolution {
  const birth = getSessionPermissionModeResolution()
  return birth?.mode === sessionMode
    ? { ...birth }
    : { mode: sessionMode, source: 'session-choice' }
}
