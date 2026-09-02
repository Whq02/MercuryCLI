import type { TaskState } from '../tasks/types.js'
import type { TaskType } from '../Task.js'
import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../tasks/InProcessTeammateTask/types.js'
import type { AppState } from './AppStateStore.js'

export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return undefined
  const task = appState.tasks[taskId]
  if (!task || !isInProcessTeammateTask(task)) return undefined
  return task
}

export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

export function getActiveAgentForInput(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): ActiveAgentForInput {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return { type: 'leader' }
  const task = appState.tasks[taskId]
  if (!task) return { type: 'leader' }
  if (isInProcessTeammateTask(task)) return { type: 'viewed', task }
  if (isPanelAgentTask(task)) return { type: 'named_agent', task }
  return { type: 'leader' }
}


export const VIEWABLE_TASK_TYPES = ['in_process_teammate', 'local_agent'] as const

export const NON_VIEWABLE_TASK_TYPES = [
  'local_bash',
  'remote_agent',
  'local_workflow',
  'monitor_mcp',
  'dream',
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
  kind: 'in_process_teammate' | 'local_agent'
  taskId: string
  name: string
  color?: string
  statusLabel: string
  isWorking: boolean
  subtitle: string
  escAction: 'interrupt' | 'main'
  task: TaskState
}

export function getViewedEscAction(task: TaskState): 'interrupt' | 'main' {
  if (
    isInProcessTeammateTask(task) &&
    task.status === 'running' &&
    task.currentWorkAbortController !== undefined
  ) {
    return 'interrupt'
  }
  return 'main'
}

export function getAttachedEscAction(
  worker: { ended?: boolean; paused?: boolean } | null,
  turnLive: boolean,
): 'interrupt' | 'detach' {
  if (worker && !worker.ended && !worker.paused && turnLive) return 'interrupt'
  return 'detach'
}

export function projectViewedAgent(
  task: TaskState,
  agentNameRegistry: ReadonlyMap<string, string>,
): ViewedAgent | undefined {
  if (isInProcessTeammateTask(task)) {
    const running = task.status === 'running'
    return {
      kind: 'in_process_teammate',
      taskId: task.id,
      name: task.identity.agentName,
      color: task.identity.color,
      statusLabel: running ? (task.isIdle ? 'idle' : 'working') : task.status,
      isWorking: running && !task.isIdle,
      subtitle: task.prompt,
      escAction: getViewedEscAction(task),
      task,
    }
  }
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
