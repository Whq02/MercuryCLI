import { useContext, useEffect, useRef, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'
import { MotionParkContext } from '../components/MotionParkContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

/**
 * Like useAnimationFrame, but re-renders only when the DERIVED value changes.
 *
 * useAnimationFrame setStates the raw clock time every interval elapse, so a
 * subscriber at 80ms commits ~12.5×/s even when the thing it renders (a blink
 * glyph that flips twice per 5.2s cycle) is unchanged — every one of those
 * commits walks the reconciler, yoga, and a full compose. Deriving INSIDE the
 * subscription and setting state with the same value lets React bail, so the
 * commit rate equals the rate the visible output actually changes.
 *
 * The derive function must return a value usable with Object.is (string,
 * number, boolean) — return a stable primitive, not a fresh object.
 *
 * Same viewport-pause contract as useAnimationFrame: attach the ref; when the
 * element scrolls offscreen the subscription drops and the clock can sleep.
 *
 * @param intervalMs - How often to sample the clock, or null to pause
 * @param derive - Maps clock time (ms) to the rendered value
 */
export function useAnimationValue<T extends string | number | boolean>(
  intervalMs: number | null,
  derive: (timeMs: number) => T,
): [ref: (element: DOMElement | null) => void, value: T] {
  const clock = useContext(ClockContext)
  // Parked = fully covered by an opaque layer: same off-switch as
  // offscreen — the covered cell keeps its last derived (static) form.
  const parked = useContext(MotionParkContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const deriveRef = useRef(derive)
  deriveRef.current = derive
  const [value, setValue] = useState<T>(() => derive(clock?.now() ?? 0))

  const active = isVisible && !parked && intervalMs !== null

  useEffect(() => {
    if (!clock || !active) return

    // Absolute-bucket sampling (see use-animation-frame.ts): same-interval
    // subscribers sample on the SAME tick, so their (rare) commits coincide
    // and batch into one compose instead of interleaving.
    let lastBucket = Math.floor(clock.now() / intervalMs!)

    const onChange = (): void => {
      const now = clock.now()
      const bucket = Math.floor(now / intervalMs!)
      if (bucket === lastBucket) return
      lastBucket = bucket
      const next = deriveRef.current(now)
      // Same-value set: React bails out, no re-render, no compose.
      setValue(prev => (Object.is(prev, next) ? prev : next))
    }

    // keepAlive: true — visible animations drive the clock
    return clock.subscribe(onChange, true)
  }, [clock, intervalMs, active])

  return [viewportRef, value]
}
