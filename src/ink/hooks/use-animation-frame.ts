import { useContext, useState } from 'react'
import { useSubscription } from '../../hooks/effects.js'
import { ClockContext } from '../components/ClockContext.js'
import { MotionParkContext } from '../components/MotionParkContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

export function useAnimationFrame(
  intervalMs: number | null = 16,
): [ref: (el: DOMElement | null) => void, time: number] {
  const clock = useContext(ClockContext)
  const parked = useContext(MotionParkContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  useSubscription(() => {
    if (!clock || intervalMs === null || !isVisible || parked) return undefined
    let bucket = Math.floor(clock.now() / intervalMs)
    return clock.subscribe(() => {
      const now = clock.now()
      const present = Math.floor(now / intervalMs)
      if (present === bucket) return
      bucket = present
      setTime(now)
    }, true)
  }, [clock, intervalMs, isVisible, parked])

  return [viewportRef, time]
}
