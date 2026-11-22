import type { Task, TaskType } from './Task.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
import { notBuilt } from './pi/holes.js'

export function getTaskByType(type: TaskType): Task | undefined {
  return notBuilt('src/tasks.ts:13')
}
