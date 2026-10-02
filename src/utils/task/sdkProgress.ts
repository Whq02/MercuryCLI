import { getSessionId } from '../../bootstrap/state.js'
import { taskRow } from '../../rows/project.js'
import { enqueueRow } from '../sdkEventQueue.js'
import type { SdkWorkflowProgress } from '../../types/tools.js'

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
  enqueueRow(
    taskRow(
      { session_id: getSessionId() },
      {
        state: 'progress',
        taskId: params.taskId,
        ...(params.toolUseId !== undefined ? { callId: params.toolUseId } : {}),
        description: params.description,
        usage: { tokens: params.totalTokens, toolUses: params.toolUses, durationMs: Date.now() - params.startTime },
        ...(params.lastToolName !== undefined ? { lastTool: params.lastToolName } : {}),
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
        ...(params.workflowProgress !== undefined ? { workflowProgress: params.workflowProgress } : {}),
      },
    ),
  )
}
