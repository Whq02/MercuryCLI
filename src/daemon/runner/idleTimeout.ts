import { logForDebugging } from '../../platform/logs/debugLog.js'
import { gracefulShutdownSync } from '../../platform/processes/gracefulShutdown.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export function createIdleTimeoutManager(isIdle: () => boolean): { start(): void; stop(): void } {
  const delayMs: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let idleSince = 0

  const stop = (): void => {
    if (timer) {
      stopTimeout(timer)
      timer = null
    }
  }

  const start = (): void => {
    stop()
    idleSince = Date.now()
    if (delayMs === null) return
    timer = startTimeout(() => {
      timer = null
      if (!isIdle()) return
      if (Date.now() - idleSince < delayMs) return
      logForDebugging(`idleTimeout: idle for ${delayMs}ms; shutting down`)
      gracefulShutdownSync(0)
    }, delayMs)
  }

  return { start, stop }
}
