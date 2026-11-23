import type { DOMElement } from '../themedRenderer.js'
import { useAnimationValue } from '../renderer/bindings/use-animation-value.js'
import { stringWidth } from '../renderer/stringWidth.js'
import type { SpinnerMode } from './spinnerMode.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../cockpit/liveGlyphs.js'

const CYCLE_PAD = 20
const LEAD_OUTSIDE = 10
const STALLED_INDEX = -10_000

export function useShimmerAnimation(
  mode: SpinnerMode,
  message: string,
  isStalled: boolean,
): [(element: DOMElement | null) => void, number] {
  const width = stringWidth(message)
  const requesting = mode === 'requesting'
  const tick = requesting ? FOCAL_TICK_MS : WORK_TICK_MS
  const [ref, index] = useAnimationValue(isStalled ? null : tick, time => {
    const step = Math.floor(time / tick) % (width + CYCLE_PAD)
    return requesting ? step - LEAD_OUTSIDE : width + LEAD_OUTSIDE - step
  })
  return [ref, isStalled ? STALLED_INDEX : index]
}
