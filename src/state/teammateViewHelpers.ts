// ============================================================================
//  src/state/teammateViewHelpers.ts — the three agent-view transitions.
//  Each is a store update returning the PREVIOUS state unchanged when
//  nothing would change (the store's identity short-circuit depends on
//  it). Local-agent identification here is a STRUCTURAL check on the type
//  discriminator — importing the task module forms a cycle.
// ============================================================================
import type { TaskState } from '../tasks/types.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { AppState } from './AppStateStore.js'

type SetAppState = (updater: (prevState: AppState) => AppState) => void

/**
 * 30 seconds (contract data). Duplicated here DELIBERATELY to break an
 * import cycle; must stay in sync with the background-task framework's
 * constant.
 */
const EVICTION_GRACE_MS = 30_000

type LocalAgentish = TaskState & {
  type: 'local_agent'
  retain?: boolean
  diskLoaded?: boolean
  evictAfter?: number
  pendingMessages?: string[]
  abortController?: AbortController
}

/** Structural discriminator check (no task-module import). */
function isLocalAgentTaskShape(task: TaskState): task is LocalAgentish {
  return task.type === 'local_agent'
}

/**
 * Release: retention off, buffered messages dropped, disk-loaded flag
 * cleared, and an eviction deadline set to now-plus-grace WHEN the task is
 * terminal, cleared to absent otherwise — the else branch matters:
 * releasing a still-running agent must not leave a stale deadline behind.
 */
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

/**
 * Enter the view of `taskId`. Retention blocks eviction, enables
 * stream-append, and triggers disk bootstrap.
 */
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

    // Copy the task map only when a task actually changes.
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

/** Exit the view: clear the viewed id and the selection mode. */
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

/**
 * Stop or dismiss, context-sensitively:
 * - non-local-agent: no change;
 * - running: abort via the task's controller and return the previous state
 *   unchanged (the abort is a side effect inside the updater);
 * - already dismissed (deadline exactly zero): no change;
 * - otherwise: release with a zero eviction deadline so list filters hide
 *   it immediately, clearing the view when it was the viewed task.
 */
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
