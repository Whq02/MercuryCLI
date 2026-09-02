import type { SetAppState, Task } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { killInProcessTeammate } from '../../utils/swarm/spawnInProcess.js'
import { logForDebugging } from '../../utils/debug.js'
import { updateTaskState } from '../../utils/task/framework.js'
import type { InProcessTeammateTaskState } from './types.js'
import { appendCappedMessage, isInProcessTeammateTask } from './types.js'

/**
 * The in-process teammate task implementation, plus teammate
 * lookup/message-injection helpers.
 */

/** Kill delegates to the swarm's in-process teammate kill. */
export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    return killInProcessTeammate(taskId, setAppState)
  },
}

/** Request a graceful shutdown; no-op unless running and not already asked. */
export function requestTeammateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    if (task.shutdownRequested) return task
    return { ...task, shutdownRequested: true }
  })
}

/** Append a message to the capped UI mirror; no-op unless running. */
export function appendTeammateMessage(
  taskId: string,
  message: Message,
  setAppState: SetAppState,
): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return { ...task, messages: appendCappedMessage(task.messages, message) }
  })
}

/**
 * Inject a user message: allowed while running OR idle (waiting for input),
 * refused only in a terminal status (the drop is debug-logged). On success
 * the string is queued for delivery AND a user message is appended to the
 * mirror so it appears immediately.
 */
export function injectUserMessageToTeammate(
  taskId: string,
  text: string,
  setAppState: SetAppState,
): boolean {
  let accepted = false
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (isTerminalTaskStatus(task.status)) {
      logForDebugging(
        `dropped user message for teammate task ${taskId} in terminal status ${task.status}`,
      )
      return task
    }
    accepted = true
    return {
      ...task,
      pendingUserMessages: [...(task.pendingUserMessages ?? []), text],
      messages: appendCappedMessage(task.messages, createUserMessage({ content: text })),
    }
  })
  return accepted
}

/**
 * Find a teammate task by its composite agent id, preferring a running
 * match (old killed tasks can coexist with a new running one carrying the
 * same agent id).
 */
export function findTeammateTaskByAgentId(
  agentId: string | undefined,
  tasks: Record<string, unknown>,
): InProcessTeammateTaskState {
  let first: InProcessTeammateTaskState | undefined
  for (const task of Object.values(tasks ?? {})) {
    if (!isInProcessTeammateTask(task)) continue
    if (task.identity.agentId !== agentId) continue
    if (task.status === 'running') return task
    first ??= task
  }
  // Callers treat a lookup as present (the historical contract); a missing
  // teammate surfaces at the use site, exactly as before.
  return first as InProcessTeammateTaskState
}

export function getAllInProcessTeammateTasks(
  tasks: Record<string, unknown>,
): InProcessTeammateTaskState[] {
  return Object.values(tasks ?? {}).filter(isInProcessTeammateTask)
}

/**
 * Running teammates sorted alphabetically by display name (a locale-aware
 * comparison of the short agent name, never the composite id). Three
 * surfaces hold a numeric index into this very array — one ordering, one
 * owner.
 */
export function getRunningTeammatesSorted(
  tasks: Record<string, unknown>,
): InProcessTeammateTaskState[] {
  return getAllInProcessTeammateTasks(tasks)
    .filter(task => task.status === 'running')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName))
}
