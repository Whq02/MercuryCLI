// ============================================================================
//  utils/cockpit/liveClock — the header's SECONDS truth (operator directive
// the concourse clock read HH:MM:SS but only repainted with the
//  15 s snapshot rebuild — "the minutes are accurate, but the seconds don't
//  actually move"). React-free 1 Hz store, subscriber-counted: ZERO timers
//  while nothing renders a clock; the ONE unref'd interval serves every
//  subscriber. This is time display, not motion — it deliberately does not
//  join the 80/160/320 ms motion-clock family (its cadence is the second
//  hand itself, and coupling it to the glyph gate would let a motion opt-out
//  freeze the time of day).
//
//  Capability posture: MERCURY_LIVE_CLOCK is default-ON in the product —
//  ~3 cells of damage per second on the live surface (the zero-idle-
//  bytes posture is AMENDED by the same directive; TASK-008's idle budget
//  measures it). Every capture pins =0 (renderScenarios seedEnv) so goldens
//  keep their authored fixture times and the idle censuses stay hermetic.
// ============================================================================
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

/** The rendered HH:MM:SS — same shape as the snapshot's baked clockOf. */
export function liveClockSnapshot(): string {
  const d = new Date(nowMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Inert subscription for the pinned/capture path — never arms the timer,
 *  so a disabled clock costs zero wakeups and zero repaints. */
export function subscribeLiveClockDisabled(): () => void {
  return () => {}
}
