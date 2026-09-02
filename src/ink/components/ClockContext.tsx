// The shared animation clock: one interval for every animation in the
// process, running only while a keep-alive subscriber is driving it, and
// slowing to half rate while the terminal is blurred.

import React, { createContext, useEffect, useState } from 'react'
import { useTerminalFocus } from '../hooks/use-terminal-focus.js'

export type Clock = {
  /** Subscribe to ticks; keep-alive subscribers are what run the interval.
   *  Subscribers are invoked with NO arguments and read `now()`. */
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  /** Elapsed ms since the clock first became active. */
  now: () => number
  /** Change the tick period (no-op for an unchanged value). */
  setInterval: (ms: number) => void
}

const FRAME_INTERVAL_MS = 16

export function createClock(intervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>()
  let period = intervalMs
  let timer: ReturnType<typeof setInterval> | null = null
  let startTime: number | null = null
  // The per-tick shared snapshot: every subscriber in a tick reads the same
  // value, which keeps animations synchronised.
  let snapshot = 0

  const elapsed = (): number => {
    if (startTime === null) startTime = performance.now()
    return performance.now() - startTime
  }

  const tick = (): void => {
    snapshot = elapsed()
    for (const onChange of subscribers.keys()) onChange()
  }

  const evaluate = (): void => {
    let keepAlive = false
    for (const flag of subscribers.values()) {
      if (flag) {
        keepAlive = true
        break
      }
    }
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (keepAlive) {
      if (startTime === null) startTime = performance.now()
      timer = setInterval(tick, period)
    }
  }

  return {
    subscribe(onChange, keepAlive) {
      subscribers.set(onChange, keepAlive)
      evaluate()
      return () => {
        subscribers.delete(onChange)
        evaluate()
      }
    },
    now() {
      if (timer !== null && snapshot !== 0) return snapshot
      return elapsed()
    },
    setInterval(ms) {
      if (ms === period) return
      period = ms
      evaluate()
    },
  }
}

export const ClockContext = createContext<Clock | null>(null)

export function ClockProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [clock] = useState(() => createClock(FRAME_INTERVAL_MS))
  const focused = useTerminalFocus()
  useEffect(() => {
    clock.setInterval(focused ? FRAME_INTERVAL_MS : FRAME_INTERVAL_MS * 2)
  }, [clock, focused])
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}
