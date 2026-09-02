// The animated-element hook: a keep-alive clock subscriber that samples on
// ABSOLUTE buckets — a subscriber fires when the shared clock crosses a
// floor(now / interval) boundary, so every consumer sharing an interval
// reaches its firing condition in the same sweep however it was mounted,
// and the framework batches all their updates into one commit. Inactive
// (offscreen, parked, or a null interval) it unsubscribes and its time
// freezes; on reactivation it resumes from the shared clock's time.

import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'
import { MotionParkContext } from '../components/MotionParkContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

const DEFAULT_INTERVAL_MS = 16

export function useAnimationFrame(
  intervalMs: number | null = DEFAULT_INTERVAL_MS,
): [ref: (el: DOMElement | null) => void, time: number] {
  const clock = useContext(ClockContext)
  const parked = useContext(MotionParkContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  const active = isVisible && !parked && intervalMs !== null

  useEffect(() => {
    if (!clock || !active) return
    const interval = intervalMs as number
    let lastBucket = Math.floor(clock.now() / interval)
    return clock.subscribe(() => {
      const now = clock.now()
      const bucket = Math.floor(now / interval)
      if (bucket === lastBucket) return
      lastBucket = bucket
      setTime(now)
    }, true)
  }, [clock, intervalMs, active])

  return [viewportRef, time]
}
