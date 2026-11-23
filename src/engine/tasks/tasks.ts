import type { Task, TaskType } from './taskBase.js'
import { LocalAgentTask } from './local-agent/crewmateTask.js'
import { LocalShellTask } from './local-shell/shellTask.js'

export function getTaskByType(type: TaskType): Task | undefined {
  const tasks: readonly Task[] = [LocalShellTask, LocalAgentTask]
  return tasks.find(task => task.type === type)
}
