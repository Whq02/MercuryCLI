
import React, { createContext, useEffect, useState } from 'react'
import { useTerminalFocus } from '../hooks/use-terminal-focus.js'

export type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  now: () => number
  setInterval: (ms: number) => void
}

const FRAME_INTERVAL_MS = 16

export function createClock(intervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>()
  let period = intervalMs
  let timer: ReturnType<typeof setInterval> | null = null
  let startTime: number | null = null
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
