
import type { DOMElement } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { SpinnerMode } from './types.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'

const CYCLE_PAD = 20
const LEAD_OUTSIDE = 10
const STALLED_INDEX = -10_000

export function useShimmerAnimation(
  mode: SpinnerMode,
  message: string,
  isStalled: boolean,
): [(element: DOMElement | null) => void, number] {
  const width = stringWidth(message)
  const cycle = width + CYCLE_PAD

  const tickMs = mode === 'requesting' ? FOCAL_TICK_MS : WORK_TICK_MS
  const [ref, index] = useAnimationValue(
    isStalled ? null : tickMs,
    timeMs => {
      const step = Math.floor(timeMs / tickMs) % cycle
      if (mode === 'requesting') {
        return step - LEAD_OUTSIDE
      }
      return width + LEAD_OUTSIDE - step
    },
  )

  return [ref, isStalled ? STALLED_INDEX : index]
}
