import type { SetAppState, Task } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { killInProcessCrewmate } from '../../utils/swarm/spawnInProcess.js'
import { logForDebugging } from '../../utils/debug.js'
import { updateTaskState } from '../../utils/task/framework.js'
import type { InProcessCrewmateTaskState } from '../InProcessCrewmateTask/types.js'
import { appendCappedMessage, isInProcessCrewmateTask } from '../InProcessCrewmateTask/types.js'


export const InProcessCrewmateTask: Task = {
  name: 'InProcessCrewmateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    return killInProcessCrewmate(taskId, setAppState)
  },
}

export function requestCrewmateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessCrewmateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    if (task.shutdownRequested) return task
    return { ...task, shutdownRequested: true }
  })
}

export function appendCrewmateMessage(
  taskId: string,
  message: Message,
  setAppState: SetAppState,
): void {
  updateTaskState<InProcessCrewmateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return { ...task, messages: appendCappedMessage(task.messages, message) }
  })
}

export function injectUserMessageToCrewmate(
  taskId: string,
  text: string,
  setAppState: SetAppState,
): boolean {
  let accepted = false
  updateTaskState<InProcessCrewmateTaskState>(taskId, setAppState, task => {
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

export function findCrewmateTaskByAgentId(
  agentId: string | undefined,
  tasks: Record<string, unknown>,
): InProcessCrewmateTaskState {
  let first: InProcessCrewmateTaskState | undefined
  for (const task of Object.values(tasks ?? {})) {
    if (!isInProcessCrewmateTask(task)) continue
    if (task.identity.agentId !== agentId) continue
    if (task.status === 'running') return task
    first ??= task
  }
  return first as InProcessCrewmateTaskState
}

export function getAllInProcessCrewmateTasks(
  tasks: Record<string, unknown>,
): InProcessCrewmateTaskState[] {
  return Object.values(tasks ?? {}).filter(isInProcessCrewmateTask)
}

export function getRunningCrewmatesSorted(
  tasks: Record<string, unknown>,
): InProcessCrewmateTaskState[] {
  return getAllInProcessCrewmateTasks(tasks)
    .filter(task => task.status === 'running')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName))
}
