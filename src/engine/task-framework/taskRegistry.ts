import type { AppState } from '../../screen/app-state/AppState.js'
import type { TaskStatus } from '../tasks/taskBase.js'
import { isTerminalTaskStatus } from '../tasks/taskBase.js'
import { isBackgroundTask, type TaskState } from '../tasks/taskState.js'
import { emitTaskStarted } from '../../daemon/runner/sdkEventQueue.js'
import { getTaskOutputDelta } from './diskOutput.js'
import { projectTaskExecution } from './executionProjection.js'
export const POLL_INTERVAL_MS = 1000
export const PANEL_GRACE_MS = 30_000

type TaskAppStateSetter = (updater: (prevState: AppState) => AppState) => void

export function updateTaskState<T extends TaskState = TaskState>(
  taskId: string,
  setAppState: TaskAppStateSetter,
  updater: (task: T) => T,
): void {
  let projected: TaskState | undefined
  setAppState(prev => {
    projected = undefined
    const existing = prev.tasks[taskId]
    if (!existing) return prev
    const updated = updater(existing as T)
    if (updated === existing) return prev
    if (updated.status !== existing.status) {
      projected = updated
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
  if (projected !== undefined) {
    projectTaskExecution(projected)
  }
}

export function registerTask(task: TaskState, setAppState: TaskAppStateSetter): void {
  let isNew = false
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isNew = existing === undefined
    const stored: TaskState =
      existing?.type === 'local_agent' && task.type === 'local_agent' && Object.hasOwn(existing, 'retain')
        ? {
            ...task,
            retain: existing.retain,
            startTime: existing.startTime,
            messages: existing.messages,
            diskLoaded: existing.diskLoaded,
            pendingMessages: existing.pendingMessages,
          }
        : task
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [task.id]: stored,
      },
    }
  })
  projectTaskExecution(task)
  if (isNew) {
    const prompt = task.type === 'local_agent' ? task.prompt : undefined
    emitTaskStarted({
      taskId: task.id,
      ...(task.toolUseId !== undefined ? { callId: task.toolUseId } : {}),
      description: task.description,
      taskType: task.type,
      ...(prompt !== undefined ? { prompt } : {}),
    })
  }
}

function retainedEvictionDue(task: TaskState, now: number): boolean {
  if ('paused' in task && task.paused !== undefined) return false
  if (!('retain' in task)) return true
  const deadline = task.evictAfter
  return deadline !== undefined && deadline <= now
}

function pruneCrewmateNameRegistry(
  registry: AppState['agentNameRegistry'],
  taskId: string,
): AppState['agentNameRegistry'] {
  const staleNames: string[] = []
  for (const [name, agentId] of registry) {
    if (String(agentId) === taskId) staleNames.push(name)
  }
  if (staleNames.length === 0) return registry
  const pruned = new Map(registry)
  for (const name of staleNames) pruned.delete(name)
  return pruned
}


export function taskOwnerGone(task: TaskState): string | null {
  if (task.status !== 'running') return null
  if (task.type === 'local_bash') {
    const handle = (task as { shellCommand?: { status?: string } | null }).shellCommand
    if (handle === null || handle === undefined) return 'its command handle is gone'
    if (handle.status !== 'running' && handle.status !== 'backgrounded') return `its command already ${handle.status}`
    return null
  }
  if (task.type === 'local_agent') {
    const controller = (task as { abortController?: AbortController }).abortController
    if (controller === undefined) return 'its controller is gone'
    if (controller.signal.aborted) return 'its controller was stopped before the row settled'
    return null
  }
  return null
}

export type LiveWorkCounts = {
  total: number
  shells: number
  agents: number
  other: number
}

export function liveBackgroundCounts(tasks: Record<string, TaskState> | undefined): LiveWorkCounts {
  const counts: LiveWorkCounts = { total: 0, shells: 0, agents: 0, other: 0 }
  for (const task of Object.values(tasks ?? {})) {
    if (!isBackgroundTask(task) || isTerminalTaskStatus(task.status as TaskStatus)) continue
    if (taskOwnerGone(task) !== null) continue
    counts.total++
    if (task.type === 'local_bash') counts.shells++
    else if (task.type === 'local_agent') counts.agents++
    else counts.other++
  }
  return counts
}

export function liveWorkWords(counts: LiveWorkCounts): string {
  const parts: string[] = []
  const say = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  say(counts.shells, 'shell command', 'shell commands')
  say(counts.agents, 'crewmate', 'crewmates')
  say(counts.other, 'background task', 'background tasks')
  if (parts.length === 0) return 'nothing'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function settleOwnerlessTasks(
  setAppState: TaskAppStateSetter,
  now: number = Date.now(),
): Array<{ id: string; reason: string }> {
  const settled: Array<{ id: string; reason: string }> = []
  setAppState(prev => {
    settled.length = 0
    let nextTasks: Record<string, TaskState> | undefined
    for (const [id, task] of Object.entries(prev.tasks)) {
      const reason = taskOwnerGone(task)
      if (reason === null) continue
      settled.push({ id, reason })
      nextTasks ??= { ...prev.tasks }
      nextTasks[id] =
        task.type === 'local_agent'
          ? { ...task, status: 'killed', endTime: now, stopReason: reason }
          : { ...task, status: 'killed', endTime: now }
    }
    if (nextTasks === undefined) return prev
    return {
      ...prev,
      tasks: nextTasks,
    }
  })
  return settled
}

export function evictTerminalTask(taskId: string, setAppState: TaskAppStateSetter): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task) return prev
    if (!isTerminalTaskStatus(task.status)) return prev
    if (!task.notified) return prev
    if (!retainedEvictionDue(task, Date.now())) return prev
    const { [taskId]: _removed, ...restTasks } = prev.tasks
    return {
      ...prev,
      tasks: restTasks,
      agentNameRegistry: pruneCrewmateNameRegistry(prev.agentNameRegistry, taskId),
    }
  })
}

export function getRunningTasks(state: AppState): TaskState[] {
  return Object.values(state.tasks).filter(task => task.status === 'running')
}

export async function generateTaskAttachments(state: AppState): Promise<{
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}> {
  const updatedTaskOffsets: Record<string, number> = {}
  const evictedTaskIds: string[] = []
  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (isTerminalTaskStatus(task.status) && task.notified) {
      evictedTaskIds.push(taskId)
      continue
    }
    if (task.status !== 'running') continue
    const { content, newOffset } = await getTaskOutputDelta(taskId, task.outputOffset)
    if (content) {
      updatedTaskOffsets[taskId] = newOffset
    }
  }
  return { updatedTaskOffsets, evictedTaskIds }
}

export function applyTaskOffsetsAndEvictions(
  setAppState: TaskAppStateSetter,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void {
  const offsetEntries = Object.entries(updatedTaskOffsets)
  if (offsetEntries.length === 0 && evictedTaskIds.length === 0) return

  setAppState(prev => {
    let nextTasks: Record<string, TaskState> | undefined
    let nextRegistry = prev.agentNameRegistry

    for (const [taskId, newOffset] of offsetEntries) {
      const task = prev.tasks[taskId]
      if (!task || task.status !== 'running') continue
      nextTasks ??= { ...prev.tasks }
      nextTasks[taskId] = { ...task, outputOffset: newOffset }
    }

    const now = Date.now()
    for (const taskId of evictedTaskIds) {
      const currentTasks = nextTasks ?? prev.tasks
      const task = currentTasks[taskId]
      if (!task) continue
      if (!isTerminalTaskStatus(task.status)) continue
      if (!task.notified) continue
      if (!retainedEvictionDue(task, now)) continue
      nextTasks ??= { ...prev.tasks }
      delete nextTasks[taskId]
      nextRegistry = pruneCrewmateNameRegistry(nextRegistry, taskId)
    }

    if (nextTasks === undefined) return prev
    return {
      ...prev,
      tasks: nextTasks,
      agentNameRegistry: nextRegistry,
    }
  })
}
