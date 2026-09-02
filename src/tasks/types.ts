import type { DreamTaskState } from './DreamTask/DreamTask.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'

/**
 * The two task-state unions and the background-task predicate.
 *
 * The unions currently enumerate the same six members, so the predicate's
 * narrowing is a formality — keep both names in step; consumers import them
 * separately. Remote-agent states are harness-delivered (their producing
 * module is deliberately absent from this tree) and reach these unions only
 * through the MonitorMcp member's any-type collapse; a re-implementation
 * that makes the union precise must keep an equivalent escape hatch for
 * harness-delivered kinds.
 */

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

/** Task states the background-task indicator may show. */
export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

/**
 * A task counts as a background task while running or pending, unless it is
 * explicitly a foreground task. The test is a field-presence test, not a
 * type test: a state shape with no isBackgrounded field always counts.
 */
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') return false
  if ('isBackgrounded' in task && task.isBackgrounded === false) return false
  return true
}
