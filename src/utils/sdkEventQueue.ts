import { randomUUID } from 'node:crypto'

import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'

/**
 * A bounded, process-global queue of out-of-band SDK system events, drained
 * only by the headless/streaming output path. The subtypes, snake_case field
 * names and value enumerations are the SDK wire contract (the editor
 * extension and the multiplexer daemon consume them).
 */

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
      /** A delta batch, not full state — consumers fold by type+index and regroup by phase. */
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

/**
 * A no-op in interactive mode: there is no drainer there, so accepted events
 * would pile to the cap and be discarded unread. The interactivity test is
 * the bootstrap flag, read live.
 */
export function enqueueSdkEvent(event: SdkEvent): void {
  if (!getIsNonInteractiveSession()) return
  if (queue.length >= QUEUE_CAP) queue.shift()
  queue.push(event)
}

/** Removes everything at once; each event is a NEW object stamped with a fresh uuid and the session id. */
export function drainSdkEvents(): Array<SdkEvent & { uuid: string; session_id: string }> {
  const drained = queue.splice(0, queue.length)
  const sessionId = getSessionId()
  return drained.map(event => ({ ...event, uuid: randomUUID(), session_id: sessionId }))
}

/**
 * The terminal bookend for a registered task. Exactly one route per exit
 * path: paths that produce the user-facing notification must not also call
 * this (double close); paths that skip it (already-notified, kill, abort)
 * must, or the consumer never sees the task end.
 */
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
