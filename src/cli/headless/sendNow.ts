import { queuedOperatorLines, releaseQueuedWordsToTurn } from '../../input-core/command-queue.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import { handOverForegroundAgentsToQueuedMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { requestShellBackground } from '../../tools/BashTool/backgroundRequest.js'

type SendNowReceiptV1 = {
  queued: number
  released: number
  crewmates: number
  shells: number
}

export const SEND_NOW_NOTHING_QUEUED: SendNowReceiptV1 = Object.freeze({ queued: 0, released: 0, crewmates: 0, shells: 0 }) as SendNowReceiptV1

export function sendQueuedWordsNow(getAppState: () => AppState, setAppState: SetAppState): SendNowReceiptV1 {
  const queued = queuedOperatorLines().length
  if (queued === 0) return SEND_NOW_NOTHING_QUEUED
  const released = releaseQueuedWordsToTurn()
  const crewmates = handOverForegroundAgentsToQueuedMessage(getAppState, setAppState)
  const shells = requestShellBackground()
  return { queued, released, crewmates, shells }
}
