import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { ToolPermissionContext } from '../../Tool.js'

/**
 * Module-level registration slots letting non-React teammate code reach the
 * leader's permission UI. The REPL registers on mount and unregisters on
 * unmount.
 */

export type SetToolUseConfirmQueueFn = (
  updater: (queue: ToolUseConfirm[]) => ToolUseConfirm[],
) => void

export type SetToolPermissionContextFn = (
  context: ToolPermissionContext,
  options?: { preserveMode?: boolean },
) => void

let leaderToolUseConfirmQueue: SetToolUseConfirmQueueFn | null = null
let leaderSetToolPermissionContext: SetToolPermissionContextFn | null = null

export function registerLeaderToolUseConfirmQueue(fn: SetToolUseConfirmQueueFn): void {
  leaderToolUseConfirmQueue = fn
}

export function getLeaderToolUseConfirmQueue(): SetToolUseConfirmQueueFn | null {
  return leaderToolUseConfirmQueue
}

export function unregisterLeaderToolUseConfirmQueue(): void {
  leaderToolUseConfirmQueue = null
}

export function registerLeaderSetToolPermissionContext(fn: SetToolPermissionContextFn): void {
  leaderSetToolPermissionContext = fn
}

export function getLeaderSetToolPermissionContext(): SetToolPermissionContextFn | null {
  return leaderSetToolPermissionContext
}

export function unregisterLeaderSetToolPermissionContext(): void {
  leaderSetToolPermissionContext = null
}
