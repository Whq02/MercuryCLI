import { sleep } from '../../../utils/sleep.js'
import { gracefulShutdown, TERMINAL_GONE_EXIT_CODE, markRunModeSignalsOwned } from '../../../utils/gracefulShutdown.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { DRAIN_CUT_WORDS } from '../../../utils/messages/turnCut.js'
import { logForDiagnosticsNoPII } from '../../../utils/diagLogs.js'
import { saveCurrentSessionCosts } from '../../../cost-tracker.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

const SIGNAL_SETTLE_MS = 5_000

function run(ports: RunnerPorts): BootMade<never> {
  const { driver, isConcourseWorker, live } = ports
  const settleOnSignal = async (code: number, cut?: string): Promise<void> => {
    live.signalCode = code
    const running = live.inFlightAbort !== null
    live.inFlightAbort?.abort(cut)
    if (running) {
      const deadline = sleep(SIGNAL_SETTLE_MS, undefined, { unref: true })
      await Promise.race([outcomeAfterAbort(), deadline])
    }
    void gracefulShutdown(code)
  }
  const outcomeAfterAbort = async (): Promise<void> => {
    while (driver.isRunning()) await sleep(20)
    await live.lastOutcomeWritten
  }
  const hostCutWords = (): string | undefined => {
    if (!isConcourseWorker) return undefined
    try {
      const workers = require('src/daemon/concourseWorkers.js') as typeof import('src/daemon/concourseWorkers.js')
      return workers.cutAtDrainCeiling(String(getSessionId()), process.pid) ? DRAIN_CUT_WORDS : undefined
    } catch {
      return undefined
    }
  }
  process.on('SIGINT', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGINT' })
    void settleOnSignal(130)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGTERM' })
    void settleOnSignal(143, hostCutWords())
  })
  process.on('SIGHUP', () => {
    logForDiagnosticsNoPII('info', 'headless_shutdown_signal', { signal: 'SIGHUP' })
    void settleOnSignal(TERMINAL_GONE_EXIT_CODE)
  })
  markRunModeSignalsOwned()
  process.on('exit', () => saveCurrentSessionCosts())
  return {}
}

export const ownSignals: BootStep<never> = { name: 'ownSignals', makes: [], run }
