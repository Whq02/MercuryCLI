import { getCommandQueue, subscribeToCommandQueue } from '../messageQueueManager.js'
import { isHeldNotice, isOperatorLine } from '../../../screen/composer/input-core/command-queue.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'heldNoticeWaits'> {
  const { driver, isConcourseWorker, isMainThreadCommand, live } = ports
  const heldNoticeWaits = (): boolean =>
    !live.sessionInitialized &&
    isConcourseWorker &&
    !live.awaitingSessionClaim &&
    !live.inputClosed &&
    !driver.isRunning() &&
    getCommandQueue().some(command => isMainThreadCommand(command) && (isHeldNotice(command) || isOperatorLine(command)))
  subscribeToCommandQueue(() => {
    if (heldNoticeWaits()) driver.kick()
  })
  if (heldNoticeWaits()) driver.kick()
  return { heldNoticeWaits }
}

export const kickHeldNotices: BootStep<'heldNoticeWaits'> = { name: 'kickHeldNotices', makes: ['heldNoticeWaits'], run }
