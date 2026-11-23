import React, { createContext, useState, useSyncExternalStore } from 'react'
import { usePublish } from '../../hooks/effects.js'
import { clockPeriodMs, subscribeIdleMotion } from '../../utils/cockpit/motionGovernor.js'
import { useTerminalFocus } from '../hooks/use-terminal-focus.js'
import { startInterval, stopInterval } from '../../utils/timers.js'

type Clock = {
  now: () => number
  subscribe: (listener: () => void, keepAlive: boolean) => () => void
  setInterval: (ms: number) => void
}

export type ClockTimers = {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const FRAME_INTERVAL_MS = 16

const REAL_CLOCK_TIMERS: ClockTimers = {
  now: () => performance.now(),
  setInterval: (fn, ms) => startInterval(fn, ms),
  clearInterval: handle => stopInterval(handle as ReturnType<typeof startInterval>),
}

export function createClock(
  intervalMs: number,
  timers: ClockTimers = REAL_CLOCK_TIMERS,
): Clock {
  const subscribers = new Map<() => void, boolean>()
  let period = intervalMs
  let hasTimer = false
  let timer: unknown = undefined
  let origin: number | null = null
  let latestTickTime = 0

  const ensureOrigin = (): number => {
    if (origin === null) origin = timers.now()
    return origin
  }

  const elapsed = (): number => timers.now() - ensureOrigin()

  const tick = (): void => {
    latestTickTime = elapsed()
    for (const listener of subscribers.keys()) {
      listener()
    }
  }

  const hasKeepAlive = (): boolean => {
    for (const keepAlive of subscribers.values()) {
      if (keepAlive) return true
    }
    return false
  }

  const settle = (): void => {
    if (hasTimer) {
      timers.clearInterval(timer)
      hasTimer = false
      timer = undefined
    }
    if (hasKeepAlive()) {
      ensureOrigin()
      timer = timers.setInterval(tick, period)
      hasTimer = true
    }
  }

  return {
    now() {
      if (hasTimer && latestTickTime !== 0) return latestTickTime
      return elapsed()
    },
    subscribe(listener, keepAlive) {
      subscribers.set(listener, keepAlive)
      settle()
      return () => {
        subscribers.delete(listener)
        settle()
      }
    },
    setInterval(ms) {
      if (ms === period) return
      period = ms
      settle()
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
  usePublish(() => {
    clock.setInterval(periodMs)
  }, [clock, periodMs])
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}
