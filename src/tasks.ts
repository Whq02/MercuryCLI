import type { Task, TaskType } from './Task.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'

export function getTaskByType(type: TaskType): Task | undefined {
  const tasks: readonly Task[] = [LocalShellTask, LocalAgentTask]
  return tasks.find(task => task.type === type)
}
