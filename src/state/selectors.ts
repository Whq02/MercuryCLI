import type { TaskState } from '../tasks/types.js'
import type { TaskType } from '../Task.js'
import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppStateStore.js'

export function composerTargetTaskId(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'mainChatTaskId'>,
): string | undefined {
  return appState.mainChatTaskId ?? appState.viewingAgentTaskId
}

export function composerTargetPinned(
  appState: Pick<AppState, 'mainChatTaskId'>,
): boolean {
  return appState.mainChatTaskId !== undefined
}

export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'named_agent'; task: LocalAgentTaskState }

export function getActiveAgentForInput(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'mainChatTaskId' | 'tasks'>,
): ActiveAgentForInput {
  const taskId = composerTargetTaskId(appState)
  if (!taskId) return { type: 'leader' }
  const task = appState.tasks[taskId]
  if (!task) return { type: 'leader' }
  if (isPanelAgentTask(task)) return { type: 'named_agent', task }
  return { type: 'leader' }
}


export const VIEWABLE_TASK_TYPES = ['local_agent'] as const

export const NON_VIEWABLE_TASK_TYPES = [
  'local_bash',
  'remote_agent',
  'local_workflow',
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
export type EveryTaskTypeClassified = Assert<IsEqual<TaskType, ClassifiedTaskType>>


export type ViewedAgent = {
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

export function getViewedEscAction(_task: TaskState): 'interrupt' | 'main' {
  return 'main'
}

export function projectViewedAgent(
  task: TaskState,
  agentNameRegistry: ReadonlyMap<string, string>,
): ViewedAgent | undefined {
  if (isPanelAgentTask(task)) {
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

export function getViewedAgent(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks' | 'agentNameRegistry'>,
): ViewedAgent | undefined {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return undefined
  const task = appState.tasks[taskId]
  if (!task) return undefined
  return projectViewedAgent(task, appState.agentNameRegistry)
}
