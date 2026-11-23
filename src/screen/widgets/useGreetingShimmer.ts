import * as React from 'react'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { useAnimationValue } from '../themedRenderer.js'
import { useSettingsMaybe } from '../settings/useSettings.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import {
  SHIMMER_SETTLED,
  SHIMMER_TICK_MS,
  shimmerPhaseKey,
  shimmerPhaseOf,
  type ShimmerPhase,
} from '../cockpit/greetingShimmer.js'
import { useIdleMotion } from '../effects/useIdleMotion.js'


export function useGreetingShimmer(
  stops: string[],
  spanCells: number,
  greetKey?: unknown,
): ShimmerPhase | null {
  const reducedMotion =
    (useSettingsMaybe()?.view?.reducedMotion ?? false) ||
    isEnvTruthy(flagEnv('MERCURY_REDUCED_MOTION'))
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

  const prevPhaseKeyRef = React.useRef(phaseKey)
  if (prevPhaseKeyRef.current !== phaseKey) {
    prevPhaseKeyRef.current = phaseKey
    if (phaseKey === SHIMMER_SETTLED && !settled) setSettled(true)
  }

  if (!animate) return null
  return shimmerPhaseOf(phaseKey, spanCells)
}
