import { flagEnv } from '../../substrate/flagRegistry.js'

export function liveClockEnabled(): boolean {
  return flagEnv('MERCURY_LIVE_CLOCK') === '0' ? false : true
}

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let nowMs = Date.now()

function arm(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    nowMs = Date.now()
    for (const l of listeners) l()
  }, 1000)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

export function subscribeLiveClock(cb: () => void): () => void {
  listeners.add(cb)
  arm()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function liveClockSnapshot(): string {
  const d = new Date(nowMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function subscribeLiveClockDisabled(): () => void {
  return () => {}
}
