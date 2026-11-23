
import type { DOMElement } from '../themedRenderer.js'
import { useAnimationValue } from '../renderer/bindings/use-animation-value.js'

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
