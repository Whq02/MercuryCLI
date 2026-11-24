import { queuedOperatorLines, releaseQueuedWordsToTurn } from '../../screen/composer/input-core/command-queue.js'
import type { AppState } from '../../screen/app-state/AppState.js'
import type { SetAppState } from '../../engine/tasks/taskBase.js'
import { handOverForegroundCrewmatesToQueuedMessage } from '../../engine/tasks/local-agent/crewmateTask.js'
import { requestShellBackground } from '../../tools/shell/backgroundRequest.js'

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
  const crewmates = handOverForegroundCrewmatesToQueuedMessage(getAppState, setAppState)
  const shells = requestShellBackground()
  return { queued, released, crewmates, shells }
}
