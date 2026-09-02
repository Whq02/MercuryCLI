import type { TaskState } from '../tasks/types.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { AppState } from './AppStateStore.js'

type SetAppState = (updater: (prevState: AppState) => AppState) => void

const EVICTION_GRACE_MS = 30_000

type LocalAgentish = TaskState & {
  type: 'local_agent'
  retain?: boolean
  diskLoaded?: boolean
  evictAfter?: number
  pendingMessages?: string[]
  abortController?: AbortController
}

function isLocalAgentTaskShape(task: TaskState): task is LocalAgentish {
  return task.type === 'local_agent'
}

function releaseLocalAgent(task: LocalAgentish): LocalAgentish {
  return {
    ...task,
    retain: false,
    pendingMessages: undefined,
    diskLoaded: false,
    evictAfter: isTerminalTaskStatus(task.status)
      ? Date.now() + EVICTION_GRACE_MS
      : undefined,
  }
}

export function enterTeammateView(taskId: string, setAppState: SetAppState): void {
  setAppState(prev => {
    const previousViewedId = prev.viewingAgentTaskId
    const previousTask =
      previousViewedId && previousViewedId !== taskId
        ? prev.tasks[previousViewedId]
        : undefined
    const previousNeedsRelease =
      previousTask !== undefined &&
      isLocalAgentTaskShape(previousTask) &&
      previousTask.retain === true

    const target = prev.tasks[taskId]
    const targetNeedsRetention =
      target !== undefined &&
      isLocalAgentTaskShape(target) &&
      (target.retain !== true || target.evictAfter !== undefined)

    const viewFieldsChange =
      prev.viewingAgentTaskId !== taskId || prev.viewSelectionMode !== 'viewing-agent'

    if (!previousNeedsRelease && !targetNeedsRetention && !viewFieldsChange) {
      return prev
    }

    let tasks = prev.tasks
    if (previousNeedsRelease || targetNeedsRetention) {
      tasks = { ...prev.tasks }
      if (previousNeedsRelease && previousViewedId) {
        tasks[previousViewedId] = releaseLocalAgent(previousTask as LocalAgentish)
      }
      if (targetNeedsRetention) {
        tasks[taskId] = {
          ...(target as LocalAgentish),
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

export function exitTeammateView(setAppState: SetAppState): void {
  setAppState(prev => {
    const viewedId = prev.viewingAgentTaskId
    if (!viewedId) {
      if (prev.viewSelectionMode === 'none') return prev
      return { ...prev, viewSelectionMode: 'none' }
    }
    const viewed = prev.tasks[viewedId]
    const needsRelease =
      viewed !== undefined && isLocalAgentTaskShape(viewed) && viewed.retain === true
    return {
      ...prev,
      ...(needsRelease
        ? { tasks: { ...prev.tasks, [viewedId]: releaseLocalAgent(viewed as LocalAgentish) } }
        : {}),
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
    }
  })
}

export function stopOrDismissAgent(taskId: string, setAppState: SetAppState): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || !isLocalAgentTaskShape(task)) return prev
    if (task.status === 'running') {
      task.abortController?.abort()
      return prev
    }
    if (task.evictAfter === 0) return prev
    const released: LocalAgentish = { ...releaseLocalAgent(task), evictAfter: 0 }
    const wasViewed = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: { ...prev.tasks, [taskId]: released },
      ...(wasViewed ? { viewingAgentTaskId: undefined, viewSelectionMode: 'none' as const } : {}),
    }
  })
}
