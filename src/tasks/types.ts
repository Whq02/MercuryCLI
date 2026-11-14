import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'


export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | MonitorMcpTaskState

export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | MonitorMcpTaskState

export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') return false
  if ('isBackgrounded' in task && task.isBackgrounded === false) return false
  return true
}
