import { withDeadline } from '../../../platform/async/deadline.js'
import { gracefulShutdown, TERMINAL_GONE_EXIT_CODE, markRunModeSignalsOwned } from '../../../platform/processes/gracefulShutdown.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { DRAIN_CUT_WORDS } from '../../../engine/message-shapes/turnCut.js'
import { saveCurrentSessionCosts } from '../../../models/usage/sessionCost.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const SIGNAL_SETTLE_MS = 5_000

function run(ports: RunnerPorts): BootMade<never> {
  const { driver, isConcourseWorker, live } = ports
  const settleOnSignal = async (code: number, cut?: string): Promise<void> => {
    live.signalCode = code
    const running = live.inFlightAbort !== null
    live.inFlightAbort?.abort(cut)
    if (running) {
      let unsubscribe: (() => void) | undefined
      try {
        await withDeadline(
          outcomeAfterAbort(stop => {
            unsubscribe = stop
          }),
          SIGNAL_SETTLE_MS,
          () => undefined,
          { unref: true },
        )
      } finally {
        unsubscribe?.()
      }
    }
    void gracefulShutdown(code)
  }
  const outcomeAfterAbort = async (onStop: (stop: () => void) => void): Promise<void> => {
    if (driver.isRunning()) {
      await new Promise<void>(resolve => {
        const stop = driver.onIdle(() => {
          if (driver.isRunning()) return
          stop()
          resolve()
        })
        onStop(stop)
        if (!driver.isRunning()) {
          stop()
          resolve()
        }
      })
    }
    await live.lastOutcomeWritten
  }
  const hostCutWords = (): string | undefined => {
    if (!isConcourseWorker) return undefined
    try {
      const workers = require('src/daemon/concourse-workers/concourseWorkers.js') as typeof import('src/daemon/concourse-workers/concourseWorkers.js')
      return workers.cutAtDrainCeiling(String(getSessionId()), process.pid) ? DRAIN_CUT_WORDS : undefined
    } catch (error) {
      passedOver(error)
      return undefined
    }
  }
  process.on('SIGINT', () => {
    void settleOnSignal(130)
  })
  process.on('SIGTERM', () => {
    void settleOnSignal(143, hostCutWords())
  })
  process.on('SIGHUP', () => {
    void settleOnSignal(TERMINAL_GONE_EXIT_CODE)
  })
  markRunModeSignalsOwned()
  process.on('exit', () => saveCurrentSessionCosts())
  return {}
}

export const ownSignals: BootStep<never> = { name: 'ownSignals', makes: [], run }
