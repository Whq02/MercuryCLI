import { randomUUID } from 'node:crypto'

import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'


export type SdkEventUsage = {
  total_tokens: number
  tool_uses: number
  duration_ms: number
}

export type SdkEvent =
  | {
      type: 'system'
      subtype: 'task_started'
      task_id: string
      tool_use_id?: string
      description: string
      task_type?: string
      workflow_name?: string
      prompt?: string
    }
  | {
      type: 'system'
      subtype: 'task_progress'
      task_id: string
      tool_use_id?: string
      description: string
      usage: SdkEventUsage
      last_tool_name?: string
      summary?: string
      workflow_progress?: unknown
    }
  | {
      type: 'system'
      subtype: 'task_notification'
      task_id: string
      tool_use_id?: string
      status: 'completed' | 'failed' | 'stopped'
      output_file: string
      summary: string
      usage?: SdkEventUsage
    }
  | {
      type: 'system'
      subtype: 'session_state_changed'
      state: 'idle' | 'running' | 'requires_action'
    }

const QUEUE_CAP = 1000

const queue: SdkEvent[] = []

export function enqueueSdkEvent(event: SdkEvent): void {
  if (!getIsNonInteractiveSession()) return
  if (queue.length >= QUEUE_CAP) queue.shift()
  queue.push(event)
}

export function drainSdkEvents(): Array<SdkEvent & { uuid: string; session_id: string }> {
  const drained = queue.splice(0, queue.length)
  const sessionId = getSessionId()
  return drained.map(event => ({ ...event, uuid: randomUUID(), session_id: sessionId }))
}

export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  options: { toolUseId?: string; summary?: string; outputFile?: string; usage?: SdkEventUsage } = {},
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    ...(options.toolUseId !== undefined ? { tool_use_id: options.toolUseId } : {}),
    status,
    output_file: options.outputFile ?? '',
    summary: options.summary ?? '',
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
  })
}
