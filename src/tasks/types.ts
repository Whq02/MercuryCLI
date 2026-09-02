import type { DreamTaskState } from './DreamTask/DreamTask.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'


export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') return false
  if ('isBackgrounded' in task && task.isBackgrounded === false) return false
  return true
}
