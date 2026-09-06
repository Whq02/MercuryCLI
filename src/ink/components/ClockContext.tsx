
import React, { createContext, useEffect, useState, useSyncExternalStore } from 'react'
import { clockPeriodMs, subscribeIdleMotion } from '../../utils/cockpit/motionGovernor.js'
import { useTerminalFocus } from '../hooks/use-terminal-focus.js'

export type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  now: () => number
  setInterval: (ms: number) => void
}

export type ClockTimers = {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (timer: unknown) => void
}

const REAL_CLOCK_TIMERS: ClockTimers = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>),
}

const FRAME_INTERVAL_MS = 16

export function createClock(intervalMs: number, timers: ClockTimers = REAL_CLOCK_TIMERS): Clock {
  const subscribers = new Map<() => void, boolean>()
  let period = intervalMs
  let timer: unknown = null
  let startTime: number | null = null
  let snapshot = 0

  const elapsed = (): number => {
    if (startTime === null) startTime = timers.now()
    return timers.now() - startTime
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
      timers.clearInterval(timer)
      timer = null
    }
    if (keepAlive) {
      if (startTime === null) startTime = timers.now()
      timer = timers.setInterval(tick, period)
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

export function providerClockPeriodMs(focused: boolean): number {
  return clockPeriodMs(focused ? FRAME_INTERVAL_MS : FRAME_INTERVAL_MS * 2)
}

export function ClockProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [clock] = useState(() => createClock(FRAME_INTERVAL_MS))
  const focused = useTerminalFocus()
  const periodMs = useSyncExternalStore(
    subscribeIdleMotion,
    () => providerClockPeriodMs(focused),
    () => providerClockPeriodMs(focused),
  )
  useEffect(() => {
    clock.setInterval(periodMs)
  }, [clock, periodMs])
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}
