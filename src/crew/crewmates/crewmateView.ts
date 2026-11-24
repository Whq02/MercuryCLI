import { isTerminalTaskStatus } from '../../engine/tasks/taskBase.js'
import type { CrewmateTaskState } from '../../engine/tasks/local-agent/crewmateTask.js'
import type { TaskState } from '../../engine/tasks/taskState.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

const EVICT_GRACE_MS = 30_000

function isLocalCrewmate(task: TaskState | undefined): task is CrewmateTaskState {
  return task !== undefined && task.type === 'local_agent'
}

function releaseTask(task: CrewmateTaskState, evictAfterOverride?: number): CrewmateTaskState {
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
    const prevId = prev.viewingCrewmateTaskId
    const prevTask = prevId && prevId !== taskId ? prev.tasks[prevId] : undefined
    const shouldReleasePrev = isLocalCrewmate(prevTask) && prevTask.retain === true

    const nextTask = prev.tasks[taskId]
    const shouldRetainNext =
      isLocalCrewmate(nextTask) && (nextTask.retain !== true || nextTask.evictAfter !== undefined)

    if (
      !shouldReleasePrev &&
      !shouldRetainNext &&
      prev.viewingCrewmateTaskId === taskId &&
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
      viewingCrewmateTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
    }
  })
}

export function exitCrewmateView(setAppState: SetAppState): void {
  setAppState(prev => {
    const prevId = prev.viewingCrewmateTaskId
    if (!prevId) {
      if (prev.viewSelectionMode === 'none') return prev
      return {
        ...prev,
        viewSelectionMode: 'none',
      }
    }

    const prevTask = prev.tasks[prevId]
    const shouldRelease = isLocalCrewmate(prevTask) && prevTask.retain === true
    const tasks = shouldRelease
      ? { ...prev.tasks, [prevId]: releaseTask(prevTask) }
      : prev.tasks

    return {
      ...prev,
      tasks,
      viewingCrewmateTaskId: undefined,
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

export function stopOrDismissCrewmate(taskId: string, setAppState: SetAppState, reason?: string): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalCrewmate(task)) return prev
    if (task.status === 'running') {
      task.abortController?.abort(reason)
      return prev
    }
    if (task.evictAfter === 0) return prev
    const tasks = {
      ...prev.tasks,
      [taskId]: releaseTask(task, 0),
    }
    const clearingView = prev.viewingCrewmateTaskId === taskId
    const clearingMainChat = prev.mainChatTaskId === taskId
    return {
      ...prev,
      tasks,
      ...(clearingView ? { viewingCrewmateTaskId: undefined, viewSelectionMode: 'none' as const } : {}),
      ...(clearingMainChat ? { mainChatTaskId: undefined } : {}),
    }
  })
}
