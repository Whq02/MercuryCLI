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
import { liveGlyphsEnabled } from '../../utils/cockpit/liveGlyphs.js'

// ============================================================================
//  useGreetingShimmer — the ONE React owner of the identity ramp's greeting
//  (schedule + settle law in utils/cockpit/greetingShimmer.ts).
//
//  A ramped identity surface calls this at mount; the returned phase feeds
//  rampSegments' `shimmer` opt. The greeting arms on MOUNT (opening a
//  surface mounts its header) and re-arms when `greetKey` changes (a
//  selection-keyed surface passes the selected row's identity). It runs
//  ~10 s on the FOCAL 80 ms lane, then returns null forever and DROPS its
//  clock subscription — settled surfaces cost zero frames (the
//  subscriber-counted timer law). useAnimationValue's own contract covers
//  the rest: offscreen/parked unsubscribes, equal phase keys never commit,
//  and a clock-less render (static prints) stays on the settled frame.
//
//  Degraded states return null from the first frame: reduced motion (the
//  settings key OR MERCURY_REDUCED_MOTION — the REPL's combined gate),
//  MERCURY_LIVE_GLYPHS=0 (capture hermeticity — every pinned capture
//  renders the settled ramp), and single-stop ramps (the reduced-colour
//  collapse law: flat surfaces have no gradient to sweep).
// ============================================================================

export function useGreetingShimmer(
  stops: string[],
  spanCells: number,
  greetKey?: unknown,
): ShimmerPhase | null {
  const reducedMotion =
    (useSettingsMaybe()?.prefersReducedMotion ?? false) ||
    isEnvTruthy(process.env.MERCURY_REDUCED_MOTION)
  const enabled = !reducedMotion && liveGlyphsEnabled() && stops.length > 1 && spanCells > 1

  const [settled, setSettled] = React.useState(false)
  const startRef = React.useRef<number | null>(null)
  const spanRef = React.useRef(spanCells)
  spanRef.current = spanCells

  // Re-arm on a greetKey change (compare-in-render, the ValueGlow idiom):
  // a fresh selection is a fresh greeting.
  const keyRef = React.useRef(greetKey)
  if (!Object.is(keyRef.current, greetKey)) {
    keyRef.current = greetKey
    startRef.current = null
    if (settled) setSettled(false)
  }

  const animate = enabled && !settled
  const [, phaseKey] = useAnimationValue(animate ? SHIMMER_TICK_MS : null, timeMs => {
    // Latch the greeting's own t0 on the first derive after (re-)arming —
    // the clock's absolute lattice stays shared; only the origin is ours.
    if (startRef.current === null) startRef.current = timeMs
    return shimmerPhaseKey(timeMs - startRef.current, spanRef.current)
  })

  // The settle latch: the terminal token drops the clock subscription.
  React.useEffect(() => {
    if (phaseKey === SHIMMER_SETTLED) setSettled(true)
  }, [phaseKey])

  if (!animate) return null
  return shimmerPhaseOf(phaseKey, spanCells)
}
