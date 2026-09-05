import { existsSync } from 'node:fs'
import type { SetAppState, TaskKillReceipt, TaskType } from '../Task.js'
import type { AppState } from '../state/AppState.js'
import { getTaskByType } from '../tasks.js'
import { readAgentTranscript } from '../tools/WorkflowTool/agentTranscriptReader.js'
import { asAgentId } from '../types/ids.js'
import { getAgentTranscriptPath } from '../utils/sessionStorage/paths.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { updateTaskState } from '../utils/task/framework.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'


export type StopTaskErrorCode = 'not_found' | 'not_running' | 'unsupported_type'

export class StopTaskError extends Error {
  code: StopTaskErrorCode

  constructor(code: StopTaskErrorCode, message: string) {
    super(message)
    this.name = 'StopTaskError'
    this.code = code
  }
}

export async function taskNotFoundWords(taskId: string): Promise<string> {
  let transcriptPath: string | null = null
  try {
    transcriptPath = getAgentTranscriptPath(asAgentId(taskId))
  } catch {
    transcriptPath = null
  }
  if (transcriptPath === null || !existsSync(transcriptPath)) return `No task found with id ${taskId}`
  const view = await readAgentTranscript(transcriptPath)
  return `No running task with id ${taskId} in this session's registry — its transcript on disk ends ${view?.end.words ?? 'unreadable'}; a message to that id (SendMessage) resumes it`
}

export async function stopTask(
  taskId: string,
  context: { getAppState: () => AppState; setAppState: SetAppState },
): Promise<{
  taskId: string
  taskType: TaskType
  command: string
  settlement?: TaskKillReceipt
}> {
  const task = context.getAppState().tasks?.[taskId]
  if (!task) {
    throw new StopTaskError('not_found', await taskNotFoundWords(taskId))
  }
  if (task.status !== 'running') {
    throw new StopTaskError(
      'not_running',
      `Task ${taskId} is not running (status: ${task.status})`,
    )
  }
  const implementation = getTaskByType(task.type as TaskType)
  if (!implementation) {
    throw new StopTaskError(
      'unsupported_type',
      `Stopping tasks of type ${task.type} is not supported`,
    )
  }

  const killReturn = await implementation.kill(taskId, context.setAppState)
  const settlement =
    typeof killReturn === 'object' &&
    killReturn !== null &&
    typeof (killReturn as { settled?: unknown }).settled === 'boolean'
      ? (killReturn as TaskKillReceipt)
      : undefined

  if (isLocalShellTask(task)) {
    let flippedHere = false
    updateTaskState(taskId, context.setAppState, current => {
      if (current.notified) return current
      flippedHere = true
      return { ...current, notified: true }
    })
    if (flippedHere) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  return {
    taskId,
    taskType: task.type as TaskType,
    command: isLocalShellTask(task) ? task.command : task.description,
    settlement,
  }
}
