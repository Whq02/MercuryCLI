import type { Task, TaskType } from './Task.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'

const MonitorMcpTask: Task | undefined = undefined

function getAllTasks(): Task[] {
  const tasks: Task[] = [LocalShellTask, LocalAgentTask]
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}

export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(task => task.type === type)
}
