import { useContext, useRef, useState } from 'react'
import { useClaim, useSubscription } from '../../hooks/effects.js'
import { ClockContext } from '../components/ClockContext.js'

export function useAnimationTimer(intervalMs: number): number {
  const clock = useContext(ClockContext)
  const [time, setTime] = useState(() => (clock ? clock.now() : 0))

  useSubscription(() => {
    if (!clock) return
    let lastTick = clock.now()
    return clock.subscribe(() => {
      const now = clock.now()
      if (now - lastTick >= intervalMs) {
        lastTick = now
        setTime(now)
      }
    }, false)
  }, [clock, intervalMs])

  return time
}

export function useInterval(callback: () => void, intervalMs: number | null): void {
  const clock = useContext(ClockContext)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useClaim(() => {
    if (!clock || intervalMs === null) return
    let lastTick = clock.now()
    return clock.subscribe(() => {
      const now = clock.now()
      if (now - lastTick >= intervalMs) {
        lastTick = now
        callbackRef.current()
      }
    }, false)
  }, [clock, intervalMs])
}
