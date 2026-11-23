import { getSessionId } from '../../boot/process-state/processState.js'
import { taskRow } from '../rows/project.js'
import { enqueueRow } from '../../daemon/runner/sdkEventQueue.js'

export function emitTaskProgress(params: {
  taskId: string
  toolUseId: string | undefined
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  lastToolName?: string
  summary?: string
}): void {
  enqueueRow(
    taskRow(
      { session_id: getSessionId() },
      {
        state: 'progress',
        taskId: params.taskId,
        ...(params.toolUseId !== undefined ? { callId: params.toolUseId } : {}),
        description: params.description,
        usage: {
          tokens: params.totalTokens,
          toolUses: params.toolUses,
          durationMs: Date.now() - params.startTime,
        },
        ...(params.lastToolName !== undefined ? { lastTool: params.lastToolName } : {}),
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
      },
    ),
  )
}
