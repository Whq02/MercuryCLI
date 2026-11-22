import { useContext, useRef, useState } from 'react'
import { useSubscription } from '../../hooks/effects.js'
import { ClockContext } from '../components/ClockContext.js'
import { MotionParkContext } from '../components/MotionParkContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

export function useAnimationValue<T extends string | number | boolean>(
  intervalMs: number | null,
  derive: (timeMs: number) => T,
): [ref: (element: DOMElement | null) => void, value: T] {
  const clock = useContext(ClockContext)
  const parked = useContext(MotionParkContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const [value, setValue] = useState(() => derive(clock ? clock.now() : 0))
  const deriveRef = useRef(derive)
  deriveRef.current = derive

  useSubscription(() => {
    if (!clock || intervalMs === null || !isVisible || parked) return undefined
    let bucket = Math.floor(clock.now() / intervalMs)
    return clock.subscribe(() => {
      const now = clock.now()
      const present = Math.floor(now / intervalMs)
      if (present === bucket) return
      bucket = present
      const next = deriveRef.current(now)
      setValue(held => (Object.is(held, next) ? held : next))
    }, true)
  }, [clock, intervalMs, isVisible, parked])

  return [viewportRef, value]
}
