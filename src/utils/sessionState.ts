import type { PermissionMode } from '../types/permissions.js'

let permissionModeListener: ((mode: PermissionMode) => void) | null = null

export function setPermissionModeChangedListener(listener: ((mode: PermissionMode) => void) | null): void {
  permissionModeListener = listener
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}
