import React, { createContext, useState, useSyncExternalStore } from 'react'
import { usePublish } from '../../hooks/effects.js'
import { clockPeriodMs, subscribeIdleMotion } from '../../utils/cockpit/motionGovernor.js'
import { useTerminalFocus } from '../hooks/use-terminal-focus.js'
import { startInterval, stopInterval } from '../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type Clock = Unbuilt

export type ClockTimers = Unbuilt

const FRAME_INTERVAL_MS = 16

export function createClock(intervalMs: number, timers?: ClockTimers): Clock {
  return notBuilt('src/ink/components/ClockContext.tsx:28')
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
