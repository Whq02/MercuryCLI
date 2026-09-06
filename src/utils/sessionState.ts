import type { PermissionMode } from '../types/permissions.js'


export type SessionState = 'idle' | 'running' | 'requires_action'

export type RequiresActionDetails = {
  tool_name: string
  action_description: string
  tool_use_id: string
  request_id: string
  input?: unknown
}

let currentState: SessionState = 'idle'
let permissionModeListener: ((mode: PermissionMode) => void) | null = null

export function getSessionState(): SessionState {
  return currentState
}

export function setPermissionModeChangedListener(listener: ((mode: PermissionMode) => void) | null): void {
  permissionModeListener = listener
}

export function notifySessionStateChanged(state: SessionState): void {
  currentState = state
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}
