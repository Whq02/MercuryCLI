import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { InProcessTeammateTask } from './tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
import { LocalWorkflowTask } from './tasks/LocalWorkflowTask/LocalWorkflowTask.js'


function resolveWorkflowTask(): Task | undefined {
  try {
    return LocalWorkflowTask
  } catch {
    return undefined
  }
}

const MonitorMcpTask: Task | undefined = undefined

export function getAllTasks(): Task[] {
  const tasks: Task[] = [LocalShellTask, LocalAgentTask, InProcessTeammateTask, DreamTask]
  const workflow = resolveWorkflowTask()
  if (workflow) tasks.push(workflow)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}

export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(task => task.type === type)
}
