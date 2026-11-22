import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type TaskState =
  Unbuilt

export type BackgroundTaskState =
  Unbuilt

export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  return notBuilt('src/tasks/types.ts:16')
}
