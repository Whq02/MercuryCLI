import type { TaskState } from '../../engine/tasks/taskState.js'
import type { TaskType } from '../../engine/tasks/taskBase.js'
import {
  isPanelCrewmateTask,
  type CrewmateTaskState,
} from '../../engine/tasks/local-agent/crewmateTask.js'
import type { AppState } from './AppStateStore.js'

export function composerTargetTaskId(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'mainChatTaskId'>,
): string | undefined {
  return appState.mainChatTaskId ?? appState.viewingAgentTaskId
}

type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'named_agent'; task: CrewmateTaskState }

export function getActiveAgentForInput(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'mainChatTaskId' | 'tasks'>,
): ActiveAgentForInput {
  const taskId = composerTargetTaskId(appState)
  if (!taskId) return { type: 'leader' }
  const task = appState.tasks[taskId]
  if (!task) return { type: 'leader' }
  if (isPanelCrewmateTask(task)) return { type: 'named_agent', task }
  return { type: 'leader' }
}


export const VIEWABLE_TASK_TYPES = ['local_agent'] as const

export const NON_VIEWABLE_TASK_TYPES = [
  'local_bash',
  'remote_agent',
  'monitor_mcp',
] as const

type ClassifiedTaskType =
  | (typeof VIEWABLE_TASK_TYPES)[number]
  | (typeof NON_VIEWABLE_TASK_TYPES)[number]
type IsEqual<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T


type EveryTaskTypeClassified = Assert<IsEqual<TaskType, ClassifiedTaskType>>

void (true satisfies EveryTaskTypeClassified)

type ViewedCrewmate = {
  kind: 'local_agent'
  taskId: string
  name: string
  color?: string
  statusLabel: string
  isWorking: boolean
  subtitle: string
  escAction: 'interrupt' | 'main'
  task: TaskState
}

function getViewedEscAction(_task: TaskState): 'interrupt' | 'main' {
  return 'main'
}

export function projectViewedCrewmate(
  task: TaskState,
  agentNameRegistry: ReadonlyMap<string, string>,
): ViewedCrewmate | undefined {
  if (isPanelCrewmateTask(task)) {
    let registeredName: string | undefined
    for (const [name, taskId] of agentNameRegistry) {
      if (taskId === task.id) registeredName = name
    }
    return {
      kind: 'local_agent',
      taskId: task.id,
      name: registeredName ?? task.description,
      statusLabel: task.status,
      isWorking: task.status === 'running',
      subtitle: task.description,
      escAction: getViewedEscAction(task),
      task,
    }
  }
  return undefined
}

export function getViewedCrewmate(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks' | 'crewmateNameRegistry'>,
): ViewedCrewmate | undefined {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return undefined
  const task = appState.tasks[taskId]
  if (!task) return undefined
  return projectViewedCrewmate(task, appState.crewmateNameRegistry)
}
