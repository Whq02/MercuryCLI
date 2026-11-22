import { getSessionId } from '../../bootstrap/state.js'
import { taskRow } from '../../rows/project.js'
import { enqueueRow } from '../sdkEventQueue.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/utils/task/sdkProgress.ts:5')
}
