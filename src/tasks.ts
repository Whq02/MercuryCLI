import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { InProcessTeammateTask } from './tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
import { LocalWorkflowTask } from './tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/**
 * The task-implementation registry (kind → implementation), used for kill
 * dispatch. The list is rebuilt on every call and never held in a
 * module-level constant — that is what lets this module be imported while
 * its members' modules are still initialising.
 */

/** The workflow implementation resolves late so the registry tolerates a
 *  circular-initialisation window; absence is tolerated. */
function resolveWorkflowTask(): Task | undefined {
  try {
    return LocalWorkflowTask
  } catch {
    return undefined
  }
}

/**
 * The MCP-monitor implementation has no producer in this product — the slot
 * exists but is hard-coded to nothing, so `monitor_mcp` remains a valid
 * task kind with no registered implementation (stopping such a task fails
 * with the unsupported-type code).
 */
const MonitorMcpTask: Task | undefined = undefined

/**
 * Every task implementation. The in-process teammate row is load-bearing:
 * lookup by kind is the only route to a teammate's kill, so omitting it
 * silently disarms every stop path that reaches teammates.
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [LocalShellTask, LocalAgentTask, InProcessTeammateTask, DreamTask]
  const workflow = resolveWorkflowTask()
  if (workflow) tasks.push(workflow)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}

/** The implementation for a task kind — first match wins. */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(task => task.type === type)
}
