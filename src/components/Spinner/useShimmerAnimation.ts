import type { DOMElement } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { SpinnerMode } from '../../types/spinner.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { notBuilt } from '../../pi/holes.js'

const CYCLE_PAD = 20
const LEAD_OUTSIDE = 10
const STALLED_INDEX = -10_000

export function useShimmerAnimation(
  mode: SpinnerMode,
  message: string,
  isStalled: boolean,
): [(element: DOMElement | null) => void, number] {
  return notBuilt('src/components/Spinner/useShimmerAnimation.ts:12')
}
