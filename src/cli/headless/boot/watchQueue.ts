import { subscribeRows, drainRows } from '../../../utils/sdkEventQueue.js'
import type { RowDraft } from '../../../rows/project.js'
import { subscribeToCommandQueue, getCommandQueue } from '../../../utils/messageQueueManager.js'
import type { NoticeRecord } from '../../../services/notices/unreadLedger.js'
import type { QueuedCommand } from '../../../types/textInputTypes.js'
import * as printDriver from '../printDriver.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'stopSdkDrain' | 'carriersOf'> {
  const { driver, emitCommandNotifications, enqueueRow, isMainThreadCommand, live } = ports
  const stopSdkDrain = subscribeRows(() => {
    for (const row of drainRows()) enqueueRow({ ...row, ...(live.currentTurn !== null ? { turn: live.currentTurn } : {}) } as RowDraft)
  })
  subscribeToCommandQueue(() => {
    const queued = getCommandQueue()
    if (queued.some(command => command.priority === 'now')) {
      live.inFlightAbort?.abort()
    }
    if (!live.inputClosed && live.sessionInitialized && !driver.isRunning() && queued.some(isMainThreadCommand)) {
      driver.kick()
      if (!driver.isRunning()) emitCommandNotifications(queued.filter(isMainThreadCommand))
    }
  })

  const carriersOf = (notices: readonly NoticeRecord[]): QueuedCommand[] => printDriver.carriersOf(notices)
  return { stopSdkDrain, carriersOf }
}

export const watchQueue: BootStep<'stopSdkDrain' | 'carriersOf'> = { name: 'watchQueue', makes: ['stopSdkDrain', 'carriersOf'], run }
