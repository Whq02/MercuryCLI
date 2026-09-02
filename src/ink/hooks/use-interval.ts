// The two shared-clock reader hooks: a time reader and a callback interval.
// Both are NON-keep-alive subscribers with a rolling per-subscriber anchor
// (re-anchored on every emission) — they only see ticks while some
// keep-alive subscriber drives the clock. Do not move them onto absolute
// buckets; that sampling rule belongs to the animation-frame hook alone.

import { useContext, useEffect, useRef, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'

export function useAnimationTimer(intervalMs: number): number {
  const clock = useContext(ClockContext)
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  useEffect(() => {
    if (!clock) return
    let anchor = clock.now()
    return clock.subscribe(() => {
      const now = clock.now()
      if (now - anchor >= intervalMs) {
        anchor = now
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

  useEffect(() => {
    if (!clock || intervalMs === null) return
    let anchor = clock.now()
    return clock.subscribe(() => {
      const now = clock.now()
      if (now - anchor >= intervalMs) {
        anchor = now
        callbackRef.current()
      }
    }, false)
  }, [clock, intervalMs])
}
