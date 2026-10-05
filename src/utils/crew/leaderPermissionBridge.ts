import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { ToolPermissionContext } from '../../Tool.js'


type SetToolUseConfirmQueueFn = (
  updater: (queue: ToolUseConfirm[]) => ToolUseConfirm[],
) => void

type SetToolPermissionContextFn = (
  context: ToolPermissionContext,
  options?: { preserveMode?: boolean },
) => void

let leaderToolUseConfirmQueue: SetToolUseConfirmQueueFn | null = null
let leaderSetToolPermissionContext: SetToolPermissionContextFn | null = null

export function getLeaderToolUseConfirmQueue(): SetToolUseConfirmQueueFn | null {
  return leaderToolUseConfirmQueue
}

export function getLeaderSetToolPermissionContext(): SetToolPermissionContextFn | null {
  return leaderSetToolPermissionContext
}
