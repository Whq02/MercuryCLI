import { isTerminalTaskStatus } from '../Task.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../tasks/types.js'
import type { AppState } from './AppStateStore.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

const EVICT_GRACE_MS = 30_000

function isLocalAgent(task: TaskState | undefined): task is LocalAgentTaskState {
  return task !== undefined && task.type === 'local_agent'
}

function releaseTask(task: LocalAgentTaskState, evictAfterOverride?: number): LocalAgentTaskState {
  const evictAfter =
    evictAfterOverride !== undefined
      ? evictAfterOverride
      : isTerminalTaskStatus(task.status)
        ? Date.now() + EVICT_GRACE_MS
        : undefined
  return {
    ...task,
    retain: false,
    pendingMessages: undefined,
    diskLoaded: false,
    evictAfter,
  }
}

export function enterCrewmateView(taskId: string, setAppState: SetAppState): void {
  setAppState(prev => {
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId && prevId !== taskId ? prev.tasks[prevId] : undefined
    const shouldReleasePrev = isLocalAgent(prevTask) && prevTask.retain === true

    const nextTask = prev.tasks[taskId]
    const shouldRetainNext =
      isLocalAgent(nextTask) && (nextTask.retain !== true || nextTask.evictAfter !== undefined)

    if (
      !shouldReleasePrev &&
      !shouldRetainNext &&
      prev.viewingAgentTaskId === taskId &&
      prev.viewSelectionMode === 'viewing-agent'
    ) {
      return prev
    }

    let tasks = prev.tasks
    if (shouldReleasePrev || shouldRetainNext) {
      tasks = { ...prev.tasks }
      if (shouldReleasePrev && prevId) {
        tasks[prevId] = releaseTask(prevTask)
      }
      if (shouldRetainNext) {
        tasks[taskId] = {
          ...nextTask,
          retain: true,
          evictAfter: undefined,
        }
      }
    }

    return {
      ...prev,
      tasks,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
    }
  })
}

export function exitCrewmateView(setAppState: SetAppState): void {
  setAppState(prev => {
    const prevId = prev.viewingAgentTaskId
    if (!prevId) {
      if (prev.viewSelectionMode === 'none') return prev
      return {
        ...prev,
        viewSelectionMode: 'none',
      }
    }

    const prevTask = prev.tasks[prevId]
    const shouldRelease = isLocalAgent(prevTask) && prevTask.retain === true
    const tasks = shouldRelease
      ? { ...prev.tasks, [prevId]: releaseTask(prevTask) }
      : prev.tasks

    return {
      ...prev,
      tasks,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
    }
  })
}

export function setMainChat(taskId: string, setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.mainChatTaskId === taskId) return prev
    return { ...prev, mainChatTaskId: taskId }
  })
}

export function clearMainChat(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.mainChatTaskId === undefined) return prev
    return { ...prev, mainChatTaskId: undefined }
  })
}

export function stopOrDismissAgent(taskId: string, setAppState: SetAppState, reason?: string): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalAgent(task)) return prev
    if (task.status === 'running') {
      task.abortController?.abort(reason)
      return prev
    }
    if (task.evictAfter === 0) return prev
    const tasks = {
      ...prev.tasks,
      [taskId]: releaseTask(task, 0),
    }
    const clearingView = prev.viewingAgentTaskId === taskId
    const clearingMainChat = prev.mainChatTaskId === taskId
    return {
      ...prev,
      tasks,
      ...(clearingView ? { viewingAgentTaskId: undefined, viewSelectionMode: 'none' as const } : {}),
      ...(clearingMainChat ? { mainChatTaskId: undefined } : {}),
    }
  })
}
