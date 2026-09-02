import { useContext, useEffect, useRef, useState } from 'react'
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
  const deriveRef = useRef(derive)
  deriveRef.current = derive
  const [value, setValue] = useState<T>(() => derive(clock?.now() ?? 0))

  const active = isVisible && !parked && intervalMs !== null

  useEffect(() => {
    if (!clock || !active) return

    let lastBucket = Math.floor(clock.now() / intervalMs!)

    const onChange = (): void => {
      const now = clock.now()
      const bucket = Math.floor(now / intervalMs!)
      if (bucket === lastBucket) return
      lastBucket = bucket
      const next = deriveRef.current(now)
      setValue(prev => (Object.is(prev, next) ? prev : next))
    }

    return clock.subscribe(onChange, true)
  }, [clock, intervalMs, active])

  return [viewportRef, value]
}
