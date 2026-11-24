import type { Task, TaskType } from './taskBase.js'
import { CrewmateTask } from './local-agent/crewmateTask.js'
import { LocalShellTask } from './local-shell/shellTask.js'

export function getTaskByType(type: TaskType): Task | undefined {
  const tasks: readonly Task[] = [LocalShellTask, CrewmateTask]
  return tasks.find(task => task.type === type)
}
