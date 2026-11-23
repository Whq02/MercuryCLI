import type { PermissionMode } from '../types/permissions.js'

type ModeListener = (mode: PermissionMode) => void

let permissionModeListener: ModeListener | null = null

export function setPermissionModeChangedListener(listener: ModeListener | null): void {
  permissionModeListener = listener
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}
