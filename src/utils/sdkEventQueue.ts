import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { taskRow, type RowDraft } from '../rows/project.js'
import { getTaskOutputPath } from './task/diskOutput.js'
import type { TaskRow } from '../rows/vocabulary.js'
import { createSignal } from './signal.js'


export type TaskUsage = {
  tokens: number
  toolUses: number
  durationMs: number
}

const QUEUE_CAP = 1000

const queue: RowDraft[] = []
const changed = createSignal()
export const subscribeRows = changed.subscribe

export function enqueueRow(row: RowDraft): void {
  if (!getIsNonInteractiveSession()) return
  if (queue.length >= QUEUE_CAP) queue.shift()
  queue.push(row)
  changed.emit()
}

export function drainRows(): RowDraft[] {
  return queue.splice(0, queue.length)
}

export function emitTaskStarted(facts: { taskId: string; callId?: string; taskType: string; description: string; workflow?: string; prompt?: string }): void {
  enqueueRow(
    taskRow(
      { session_id: getSessionId() },
      {
        state: 'started',
        taskId: facts.taskId,
        ...(facts.callId !== undefined ? { callId: facts.callId } : {}),
        taskType: facts.taskType,
        description: facts.description,
        ...(facts.workflow !== undefined ? { workflow: facts.workflow } : {}),
        ...(facts.prompt !== undefined ? { prompt: facts.prompt } : {}),
      },
    ),
  )
}

export const SETTLE_GRACE_MS = 250
const SETTLE_SHADOW_MS = 30_000
const bookendAt = new Map<string, number>()

export function markTaskBookend(taskId: string): void {
  bookendAt.set(taskId, Date.now())
}

export function emitTaskEnded(
  taskId: string,
  status: NonNullable<TaskRow['status']>,
  options: { toolUseId?: string; summary?: string; outputFile?: string; usage?: TaskUsage; settle?: boolean } = {},
): void {
  if (options.settle === true) {
    const asked = Date.now()
    const timer = setTimeout(() => {
      const bookend = bookendAt.get(taskId)
      if (bookend !== undefined && Math.abs(bookend - asked) < SETTLE_SHADOW_MS) return
      enqueueTaskEnded(taskId, status, options)
    }, SETTLE_GRACE_MS)
    timer.unref?.()
    return
  }
  markTaskBookend(taskId)
  enqueueTaskEnded(taskId, status, options)
}

function enqueueTaskEnded(
  taskId: string,
  status: NonNullable<TaskRow['status']>,
  options: { toolUseId?: string; summary?: string; outputFile?: string; usage?: TaskUsage },
): void {
  enqueueRow(
    taskRow(
      { session_id: getSessionId() },
      {
        state: 'ended',
        taskId,
        ...(options.toolUseId !== undefined ? { callId: options.toolUseId } : {}),
        status,
        outputFile: options.outputFile ?? getTaskOutputPath(taskId),
        summary: options.summary ?? '',
        ...(options.usage !== undefined ? { usage: options.usage } : {}),
      },
    ),
  )
}
