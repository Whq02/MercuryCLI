import { enqueueSdkEvent } from '../sdkEventQueue.js'
import type { SdkWorkflowProgress } from '../../types/tools.js'

/**
 * Emits the SDK `task_progress` system event from already-computed
 * counters, so callers with different state shapes (a background agent's
 * progress tracker; a workflow task's state) each derive them their own
 * way. The only computation here is the elapsed duration; every other value
 * is forwarded unchanged — whether an absent optional disappears from the
 * emitted JSON or appears as null is the event queue's serialisation
 * behaviour, not this module's.
 */
export function emitTaskProgress(params: {
  taskId: string
  toolUseId: string | undefined
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  lastToolName?: string
  summary?: string
  workflowProgress?: SdkWorkflowProgress[]
}): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    description: params.description,
    usage: {
      total_tokens: params.totalTokens,
      tool_uses: params.toolUses,
      duration_ms: Date.now() - params.startTime,
    },
    last_tool_name: params.lastToolName,
    summary: params.summary,
    workflow_progress: params.workflowProgress,
  })
}
