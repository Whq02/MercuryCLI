import { logForDebugging } from './debug.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'

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
      if (!isIdle()) return
      if (Date.now() - idleSince < delayMs) return
      logForDebugging(`idleTimeout: idle for ${delayMs}ms; shutting down`)
      gracefulShutdownSync(0)
    }, delayMs)
  }

  return { start, stop }
}
