import type { AppState } from '../../state/AppState.js'
import type { TaskStatus, TaskType } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'
import { getTaskOutputDelta } from './diskOutput.js'
import { projectTaskExecution } from './executionProjection.js'


export const POLL_INTERVAL_MS = 1000
export const STOPPED_DISPLAY_MS = 3000
export const PANEL_GRACE_MS = 30_000

export type TaskAttachment = {
  type: 'task_status'
  taskId: string
  toolUseId?: string
  taskType: TaskType
  status: TaskStatus
  description: string
  deltaSummary: string | null
}

type TaskAppStateSetter = (updater: (prevState: AppState) => AppState) => void

export function updateTaskState<T extends TaskState = TaskState>(
  taskId: string,
  setAppState: TaskAppStateSetter,
  updater: (task: T) => T,
): void {
  let statusChanged: TaskState | undefined
  setAppState(prevState => {
    const task = prevState.tasks?.[taskId] as T | undefined
    if (!task) return prevState
    const updated = updater(task)
    if (updated === task) return prevState
    if ((updated as TaskState).status !== (task as TaskState).status) statusChanged = updated as TaskState
    return { ...prevState, tasks: { ...prevState.tasks, [taskId]: updated } }
  })
  if (statusChanged) projectTaskExecution(statusChanged)
}

export function registerTask(task: TaskState, setAppState: TaskAppStateSetter): void {
  let isReplacement = false
  setAppState(prevState => {
    const existing = prevState.tasks[task.id]
    let stored: TaskState = task
    if (existing) {
      isReplacement = true
      if ('retain' in existing) {
        stored = {
          ...task,
          retain: existing.retain,
          startTime: existing.startTime,
          messages: existing.messages,
          diskLoaded: existing.diskLoaded,
          pendingMessages: existing.pendingMessages,
        } as TaskState
      }
    }
    return { ...prevState, tasks: { ...prevState.tasks, [task.id]: stored } }
  })
  projectTaskExecution(task)
  if (!isReplacement) {
    enqueueSdkEvent({
      type: 'system',
      subtype: 'task_started',
      task_id: task.id,
      ...(task.toolUseId !== undefined ? { tool_use_id: task.toolUseId } : {}),
      description: task.description,
      task_type: task.type,
      ...('workflowName' in task && task.workflowName !== undefined ? { workflow_name: task.workflowName } : {}),
      ...('prompt' in task && typeof task.prompt === 'string' ? { prompt: task.prompt } : {}),
    })
  }
}

function retainedEvictionDue(task: TaskState, now: number): boolean {
  if (!('retain' in task)) return true
  const deadline = task.evictAfter
  return deadline !== undefined && deadline <= now
}

export function evictTerminalTask(taskId: string, setAppState: TaskAppStateSetter): void {
  setAppState(prevState => {
    const task = prevState.tasks?.[taskId]
    if (!task) return prevState
    if (!isTerminalTaskStatus(task.status)) return prevState
    if (!task.notified) return prevState
    if (!retainedEvictionDue(task, Date.now())) return prevState

    const tasks = { ...prevState.tasks }
    delete tasks[taskId]

    let registry = prevState.agentNameRegistry
    const staleNames: string[] = []
    for (const [name, agentId] of registry) {
      if (String(agentId) === taskId) staleNames.push(name)
    }
    if (staleNames.length > 0) {
      registry = new Map(registry)
      for (const name of staleNames) registry.delete(name)
    }
    return { ...prevState, tasks, agentNameRegistry: registry }
  })
}

export function getRunningTasks(state: AppState): TaskState[] {
  return Object.values(state.tasks ?? {}).filter(task => task.status === 'running')
}

export async function generateTaskAttachments(state: AppState): Promise<{
  attachments: TaskAttachment[]
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}> {
  const attachments: TaskAttachment[] = []
  const updatedTaskOffsets: Record<string, number> = {}
  const evictedTaskIds: string[] = []
  for (const task of Object.values(state.tasks ?? {})) {
    if (task.notified) {
      if (isTerminalTaskStatus(task.status)) {
        evictedTaskIds.push(task.id)
        continue
      }
      if (task.status !== 'running') continue
    } else if (task.status !== 'running') {
      continue
    }
    const delta = await getTaskOutputDelta(task.id, task.outputOffset)
    if (delta.content) updatedTaskOffsets[task.id] = delta.newOffset
  }
  return { attachments, updatedTaskOffsets, evictedTaskIds }
}

export function applyTaskOffsetsAndEvictions(
  setAppState: TaskAppStateSetter,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void {
  if (Object.keys(updatedTaskOffsets).length === 0 && evictedTaskIds.length === 0) return
  setAppState(prevState => {
    let changed = false
    const tasks = { ...prevState.tasks }
    for (const [taskId, newOffset] of Object.entries(updatedTaskOffsets)) {
      const task = tasks[taskId]
      if (!task || task.status !== 'running') continue
      tasks[taskId] = { ...task, outputOffset: newOffset }
      changed = true
    }
    const now = Date.now()
    for (const taskId of evictedTaskIds) {
      const task = tasks[taskId]
      if (!task) continue
      if (!isTerminalTaskStatus(task.status)) continue
      if (!task.notified) continue
      if (!retainedEvictionDue(task, now)) continue
      delete tasks[taskId]
      changed = true
    }
    if (!changed) return prevState
    return { ...prevState, tasks }
  })
}
