import type { CrewmateTaskState } from './local-agent/crewmateTask.js'
import type { LocalShellTaskState } from './local-shell/shellTaskState.js'
import type { MonitorMcpTaskState } from './monitor-mcp/MonitorMcpTask.js'

export type TaskState =
  | LocalShellTaskState
  | CrewmateTaskState
  | MonitorMcpTaskState

export type BackgroundTaskState =
  | LocalShellTaskState
  | CrewmateTaskState
  | MonitorMcpTaskState

export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') {
    return false
  }
  if (task.type !== 'monitor_mcp' && task.isBackgrounded === false) {
    return false
  }
  return true
}
