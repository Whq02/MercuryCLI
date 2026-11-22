import type { PermissionMode } from '../types/permissions.js'
import { notBuilt } from '../pi/holes.js'

export function setPermissionModeChangedListener(listener: ((mode: PermissionMode) => void) | null): void {
  return notBuilt('src/utils/sessionState.ts:5')
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  return notBuilt('src/utils/sessionState.ts:9')
}
