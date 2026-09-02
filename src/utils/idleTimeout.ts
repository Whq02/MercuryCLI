import { logForDebugging } from './debug.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'

/**
 * SDK/headless idle shutdown — permanently inert: no delay knob exists,
 * so no delay is ever armed. The manager shape stays
 * because the print driver contract threads its start/stop hooks.
 */
export function createIdleTimeoutManager(isIdle: () => boolean): { start(): void; stop(): void } {
  const delayMs: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let idleSince = 0

  const stop = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const start = (): void => {
    stop()
    idleSince = Date.now()
    if (delayMs === null) return
    timer = setTimeout(() => {
      timer = null
      // The predicate guards against resumed work; the elapsed check against
      // an early-firing timer or a clock adjustment.
      if (!isIdle()) return
      if (Date.now() - idleSince < delayMs) return
      logForDebugging(`idleTimeout: idle for ${delayMs}ms; shutting down`)
      gracefulShutdownSync(0)
    }, delayMs)
  }

  return { start, stop }
}
