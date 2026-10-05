import type { Task, TaskType } from './Task.js'
import { InProcessCrewmateTask } from './tasks/InProcessCrewmateTask/InProcessCrewmateTask.js'
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

function getAllTasks(): Task[] {
  const tasks: Task[] = [LocalShellTask, LocalAgentTask, InProcessCrewmateTask]
  const workflow = resolveWorkflowTask()
  if (workflow) tasks.push(workflow)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}

export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(task => task.type === type)
}
