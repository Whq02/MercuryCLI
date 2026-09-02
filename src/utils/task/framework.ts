import type { AppState } from '../../state/AppState.js'
import type { TaskStatus, TaskType } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'
import { getTaskOutputDelta } from './diskOutput.js'
import { projectTaskExecution } from './executionProjection.js'

/**
 * The task registry chokepoints over app state: register / update / evict,
 * the running-task query, and the delta+eviction sweep. Every mutation in
 * the product goes through here so lifecycle mirroring into the execution
 * plane, SDK event emission, and routing-registry hygiene each happen
 * exactly once per transition.
 */

/** The standard cadence for all task polling. */
export const POLL_INTERVAL_MS = 1000
/** How long a killed/stopped task stays visible before eviction is attempted. */
export const STOPPED_DISPLAY_MS = 3000
/**
 * How long a terminal agent task lingers in the coordinator panel before it
 * may be evicted. Re-declared locally in `state/teammateViewHelpers.ts`
 * (importing it there would close a module cycle) — the two must stay in
 * sync.
 */
export const PANEL_GRACE_MS = 30_000

/**
 * The per-task record the sweep would hand to the attachment feed. The
 * field names are a seam with that layer as well as with the notification
 * text.
 */
export type TaskAttachment = {
  type: 'task_status'
  taskId: string
  toolUseId?: string
  taskType: TaskType
  status: TaskStatus
  description: string
  deltaSummary: string | null
}

// The framework declares this shape module-locally; the identically shaped
// type exported from the task root module is the one other code imports.
type TaskAppStateSetter = (updater: (prevState: AppState) => AppState) => void

/**
 * Replace one task through its updater. An absent task, or an updater that
 * returns its input by reference, leaves the store object identical by
 * reference so task-map subscribers do not re-render on unchanged state.
 * A status change mirrors into the execution plane only after the store
 * write has settled — never from inside the updater, which a store may
 * invoke more than once.
 */
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

/**
 * Insert (or replace) a task under its id.
 *
 * A replacement whose existing entry carries the retain field (an
 * agent-style task whose panel row the user can pin) inherits the pin, the
 * original start time, the accumulated messages, the transcript-loaded
 * flag, and the pending-message queue — resuming a background agent
 * re-registers the task, and the user's pin, the panel sort, and the
 * just-typed prompt must all survive the replace.
 *
 * The execution plane always sees the task as supplied by the caller (the
 * projection is idempotent on unchanged state), and `task_started` is
 * emitted only for a genuinely new registration — a double emit would read
 * as two tasks to external clients.
 */
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

/** Passed the retain gate: evict only once the deadline has passed. Absent ⇒ never (a pinned row); zero ⇒ now (dismiss). */
function retainedEvictionDue(task: TaskState, now: number): boolean {
  if (!('retain' in task)) return true
  const deadline = task.evictAfter
  return deadline !== undefined && deadline <= now
}

/**
 * Eagerly release a terminal task so memory frees without waiting for the
 * sweep. Removal requires: present, terminal, notified, and — for
 * retain-carrying tasks — an expired eviction deadline. The gate keys off
 * the presence of the retain field, not of the deadline, so a retained task
 * that never had a deadline set stays protected.
 */
export function evictTerminalTask(taskId: string, setAppState: TaskAppStateSetter): void {
  setAppState(prevState => {
    const task = prevState.tasks?.[taskId]
    if (!task) return prevState
    if (!isTerminalTaskStatus(task.status)) return prevState
    if (!task.notified) return prevState
    if (!retainedEvictionDue(task, Date.now())) return prevState

    const tasks = { ...prevState.tasks }
    delete tasks[taskId]

    // Prune every routing entry pointing at the evicted id (agent id and
    // task id are the same string for these tasks, but the stored value is
    // a branded id, hence the string comparison). Without this the map grew
    // without bound and a reused agent name silently routed to a dead
    // agent. Cloned only when something is actually removed.
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

/** Every running task, in the task map's own key order, as the live objects. */
export function getRunningTasks(state: AppState): TaskState[] {
  return Object.values(state.tasks ?? {}).filter(task => task.status === 'running')
}

/**
 * The delta half of the sweep. Deliberately serial — one awaited disk read
 * at a time keeps the TOCTOU window per-task rather than global. The
 * attachments array is always empty by design: each task type emits its own
 * completion notification through the pending-notification queue, and
 * producing completion attachments here as well would deliver the same
 * completion twice. The return value carries only the offset patch, never
 * whole task snapshots — merging a stale snapshot back would clobber a
 * transition that landed during the await and zombify the task.
 */
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
      // Un-notified pending or terminal tasks contribute nothing.
      continue
    }
    const delta = await getTaskOutputDelta(task.id, task.outputOffset)
    if (delta.content) updatedTaskOffsets[task.id] = delta.newOffset
  }
  return { attachments, updatedTaskOffsets, evictedTaskIds }
}

/**
 * Apply the sweep against FRESH state: an offset lands only on a task still
 * running, and an eviction only on a task still present, terminal,
 * notified, and past its deadline — a resume can replace the task during
 * the awaited read. Empty inputs perform no state write at all.
 */
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
