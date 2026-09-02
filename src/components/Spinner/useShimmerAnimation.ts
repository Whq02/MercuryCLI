// Glimmer sweep index for a message of known display width: a
// cycle of messageWidth + 20 beginning ten cells outside the leading edge,
// left-to-right in the requesting mode and right-to-left otherwise. While
// stalled it returns a far-outside sentinel and UNSUBSCRIBES from its clock
// (intervalMs null) so the still-waiting state costs no frames.

import type { DOMElement } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { SpinnerMode } from './types.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'

const CYCLE_PAD = 20
const LEAD_OUTSIDE = 10
/** Far outside any message — the stalled sentinel. */
const STALLED_INDEX = -10_000

export function useShimmerAnimation(
  mode: SpinnerMode,
  message: string,
  isStalled: boolean,
): [(element: DOMElement | null) => void, number] {
  const width = stringWidth(message)
  const cycle = width + CYCLE_PAD

  // Requesting rides the FOCAL lane; every other mode the WORK lane — the
  // shared 80 ⊂ 160 lattice, never a raw interval.
  const tickMs = mode === 'requesting' ? FOCAL_TICK_MS : WORK_TICK_MS
  const [ref, index] = useAnimationValue(
    isStalled ? null : tickMs,
    timeMs => {
      const step = Math.floor(timeMs / tickMs) % cycle
      if (mode === 'requesting') {
        // Left-to-right: start ten cells outside the leading (left) edge.
        return step - LEAD_OUTSIDE
      }
      // Right-to-left: start ten cells outside the trailing edge.
      return width + LEAD_OUTSIDE - step
    },
  )

  return [ref, isStalled ? STALLED_INDEX : index]
}
