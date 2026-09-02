import type { SetAppState, TaskKillReceipt, TaskType } from '../Task.js'
import type { AppState } from '../state/AppState.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { updateTaskState } from '../utils/task/framework.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'

/**
 * Stop a running task by id — shared by the model-invoked stop tool and
 * the SDK stop-task control request.
 */

export type StopTaskErrorCode = 'not_found' | 'not_running' | 'unsupported_type'

export class StopTaskError extends Error {
  code: StopTaskErrorCode

  constructor(code: StopTaskErrorCode, message: string) {
    super(message)
    this.name = 'StopTaskError'
    this.code = code
  }
}

/**
 * Stop a task. Asking a process to stop and knowing that it stopped are
 * different facts — when the implementation's kill returns a settlement
 * receipt, it crosses this boundary intact rather than being thrown away.
 */
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
    throw new StopTaskError('not_found', `No task found with id ${taskId}`)
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
  // The receipt crosses this boundary intact when the kill returned one:
  // an object carrying a boolean settled flag is a settlement receipt.
  const settlement =
    typeof killReturn === 'object' &&
    killReturn !== null &&
    typeof (killReturn as { settled?: unknown }).settled === 'boolean'
      ? (killReturn as TaskKillReceipt)
      : undefined

  if (isLocalShellTask(task)) {
    // Suppress the terminal notification — the exit-code notice would be
    // noise on an explicit stop. Suppressing the XML notification also
    // suppresses the print path's parsed SDK event, so emit the terminated
    // event directly — but only when THIS call flipped the flag (on the
    // nominal path the kill already set it together with the killed
    // status; this step is live only in the stop-raced-settlement window,
    // where it is what closes the SDK bookend). Agent tasks are NOT
    // suppressed: their abort path's notification carries the partial
    // result, which is payload, not noise.
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
