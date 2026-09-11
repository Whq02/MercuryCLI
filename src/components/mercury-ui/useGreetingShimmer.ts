import * as React from 'react'
import { useAnimationValue } from '../../ink.js'
import { useSettingsMaybe } from '../../hooks/useSettings.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  SHIMMER_SETTLED,
  SHIMMER_TICK_MS,
  shimmerPhaseKey,
  shimmerPhaseOf,
  type ShimmerPhase,
} from '../../utils/cockpit/greetingShimmer.js'
import { useIdleMotion } from '../../hooks/useIdleMotion.js'


export function useGreetingShimmer(
  stops: string[],
  spanCells: number,
  greetKey?: unknown,
): ShimmerPhase | null {
  const reducedMotion =
    (useSettingsMaybe()?.prefersReducedMotion ?? false) ||
    isEnvTruthy(process.env.MERCURY_REDUCED_MOTION)
  const glyphMotion = useIdleMotion('glyphs')
  const enabled = !reducedMotion && glyphMotion !== 'off' && stops.length > 1 && spanCells > 1

  const [settled, setSettled] = React.useState(false)
  const startRef = React.useRef<number | null>(null)
  const spanRef = React.useRef(spanCells)
  spanRef.current = spanCells

  const keyRef = React.useRef(greetKey)
  if (!Object.is(keyRef.current, greetKey)) {
    keyRef.current = greetKey
    startRef.current = null
    if (settled) setSettled(false)
  }

  const animate = enabled && !settled
  const [, phaseKey] = useAnimationValue(animate ? SHIMMER_TICK_MS : null, timeMs => {
    if (startRef.current === null) startRef.current = timeMs
    return shimmerPhaseKey(timeMs - startRef.current, spanRef.current)
  })

  React.useEffect(() => {
    if (phaseKey === SHIMMER_SETTLED) setSettled(true)
  }, [phaseKey])

  if (!animate) return null
  return shimmerPhaseOf(phaseKey, spanCells)
}
