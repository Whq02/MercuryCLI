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


export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    return killInProcessTeammate(taskId, setAppState)
  },
}

export function requestTeammateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    if (task.shutdownRequested) return task
    return { ...task, shutdownRequested: true }
  })
}

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
  return first as InProcessTeammateTaskState
}

export function getAllInProcessTeammateTasks(
  tasks: Record<string, unknown>,
): InProcessTeammateTaskState[] {
  return Object.values(tasks ?? {}).filter(isInProcessTeammateTask)
}

export function getRunningTeammatesSorted(
  tasks: Record<string, unknown>,
): InProcessTeammateTaskState[] {
  return getAllInProcessTeammateTasks(tasks)
    .filter(task => task.status === 'running')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName))
}
