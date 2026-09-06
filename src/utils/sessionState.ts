import type { PermissionMode } from '../types/permissions.js'


export type SessionState = 'idle' | 'running' | 'requires_action'

export type RequiresActionDetails = {
  tool_name: string
  action_description: string
  tool_use_id: string
  request_id: string
  input?: unknown
}

export type SessionExternalMetadata = {
  permission_mode?: string | null
  model?: string | null
  pending_action?: RequiresActionDetails | null
  task_summary?: string | null
}

let currentState: SessionState = 'idle'
let pendingActionOutstanding = false
let permissionModeListener: ((mode: PermissionMode) => void) | null = null

export function getSessionState(): SessionState {
  return currentState
}

export function setPermissionModeChangedListener(listener: ((mode: PermissionMode) => void) | null): void {
  permissionModeListener = listener
}

export function notifySessionMetadataChanged(_metadata: SessionExternalMetadata): void {
}

export function notifySessionStateChanged(state: SessionState, details?: RequiresActionDetails): void {
  currentState = state
  if (state === 'requires_action' && details) {
    pendingActionOutstanding = true
    notifySessionMetadataChanged({ pending_action: details })
  } else if (pendingActionOutstanding) {
    pendingActionOutstanding = false
    notifySessionMetadataChanged({ pending_action: null })
  }
  if (state === 'idle') {
    notifySessionMetadataChanged({ task_summary: null })
  }
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}
