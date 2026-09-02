// Synchronised blink: every consumer derives its phase from the ONE
// shared animation clock, so all blinkers agree; the clock runs only while
// a subscriber is visible, pauses on terminal blur, and a paused or
// disabled blinker reads VISIBLE (true), never hidden.

import type { DOMElement } from '../ink.js'
import { useAnimationValue } from '../ink/hooks/use-animation-value.js'

const DEFAULT_INTERVAL_MS = 600

export function useBlink(
  enabled: boolean,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): [(element: DOMElement | null) => void, boolean] {
  const [ref, visible] = useAnimationValue(
    enabled ? intervalMs : null,
    time => Math.floor(time / intervalMs) % 2 === 0,
  )
  return [ref, enabled ? (visible ?? true) : true]
}
