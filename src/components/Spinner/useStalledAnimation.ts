import { useRef } from 'react'
import { getPulseActivity, pulseNow, type TurnPhaseName } from '../../utils/pulse/index.js'
import type { SpinnerMode } from './types.js'

// ============================================================================
// phase-aware "still waiting", not stall-red.
//
//  The old machinery turned the spinner CRIMSON after 3s without tokens —
//  including every normal pre-first-chunk provider wait, so a healthy
//  Opus/Fable call at high effort routinely LOOKED like a failure. Replaced:
//
//  · accepted/preparing/compacting/dispatching/waiting (pre-first-chunk) are
//    NEVER stalled, no matter how long — provider waiting is progress and
//    keeps its calm info-channel paint.
//  · thinking and tool-work are active work, never stalled.
//  · Only a RESPONDING stream with a real mid-stream gap earns attention,
//    after MID_STREAM_STILL_WAITING_MS without any stream event — and the
//    treatment is RESTRAINED: a quiet "still waiting" flag + a low-intensity
//    ease toward the theme's AMBER attention role. Never CRIMSON, never an
//    ETA, never fake progress. CRIMSON is reserved for real terminal failure
//    and no longer flows from this machinery at all.
//
//  The hook stays driven by the parent's animation clock `time` (so it slows
//  when the terminal is blurred), but GAP MEASUREMENT rides the monotonic
//  pulse clock — reduced motion (frozen animation time) still measures real
//  gaps, and any render shows the instantly-correct state.
// ============================================================================

/** Mid-stream gap before the restrained "still waiting" treatment. Healthy
 *  Opus/Fable streams at high effort routinely pause whole seconds between
 *  deltas (long tool-argument planning, server-side batching) — the old 3s
 *  bar flagged NORMAL provider cadence as failure. 10s sits beyond the p99
 *  of healthy mid-stream gaps while still naming a genuinely wedged stream
 *  promptly. */
export const MID_STREAM_STILL_WAITING_MS = 10_000

/** The attention ease tops out at a HALF blend toward the amber role —
 *  attention, not alarm (the restrained-treatment law). */
export const STILL_WAITING_MAX_INTENSITY = 0.5

export type StallViewInput = {
  /** A pulse turn is open — the phase machine is authoritative. */
  pulseOpen: boolean
  /** The authoritative phase (meaningful when pulseOpen). */
  phase: TurnPhaseName
  /** Legacy SpinnerMode — the permanent fallback classification when no
   *  pulse turn is open (compact-progress overrides, pre-wire channels). */
  mode: SpinnerMode
  /** External suppression: active tools / idle leader (teammate view). */
  suppressed: boolean
  /** Monotonic stamp of the last stream event (pulse activity, or the
   *  fallback token-growth stamp); null = nothing streamed yet. */
  lastEventAt: number | null
  /** Monotonic now (pulseNow()). */
  now: number
}

export type StallView = {
  /** The restrained mid-stream flag ("still waiting" byline + amber ease). */
  stillWaiting: boolean
  /** The ease target: 0 or STILL_WAITING_MAX_INTENSITY. */
  targetIntensity: number
}

/** Pure per-frame assessment — the whole Slice-3 truth table. */
export function computeStallView(a: StallViewInput): StallView {
  const calm: StallView = { stillWaiting: false, targetIntensity: 0 }
  if (a.suppressed) return calm
  // Only a mid-RESPONSE gap is ever a stall. Pre-first-chunk waits
  // (accepted…waiting), thinking, tool-work and settling are normal activity
  // no matter how long they run; in the fallback world the same holds for
  // requesting/thinking/tool modes.
  if (a.pulseOpen ? a.phase !== 'responding' : a.mode !== 'responding') return calm
  // No stream event yet ⇒ still a provider wait, not a mid-stream gap.
  if (a.lastEventAt === null) return calm
  const gap = a.now - a.lastEventAt
  if (gap < MID_STREAM_STILL_WAITING_MS) return calm
  return { stillWaiting: true, targetIntensity: STILL_WAITING_MAX_INTENSITY }
}

/** Pure easing step toward the target (the old 50ms-step exponential ease,
 *  kept for the same soft feel). Reduced motion is instant. */
export function easeAttention(
  current: number,
  target: number,
  dtMs: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return target
  if (dtMs <= 0) return current
  const steps = Math.floor(dtMs / 50)
  let value = current
  for (let i = 0; i < steps; i++) {
    const diff = target - value
    if (Math.abs(diff) < 0.01) return target
    value += diff * 0.1
  }
  return value
}

export type StalledAnimationArgs = {
  pulseOpen: boolean
  phase: TurnPhaseName
  mode: SpinnerMode
  currentResponseLength: number
  suppressed: boolean
  reducedMotion: boolean
}

// Driven by the parent's animation clock `time` (blur-slowdown preserved);
// no internal timers.
export function useStalledAnimation(
  time: number,
  {
    pulseOpen,
    phase,
    mode,
    currentResponseLength,
    suppressed,
    reducedMotion,
  }: StalledAnimationArgs,
): {
  stillWaiting: boolean
  attentionIntensity: number
} {
  // Fallback stream cadence (no pulse turn): token growth IS the stream
  // event, stamped on the monotonic clock. A length reset (new turn reusing
  // the mount) clears the stamp — nothing streamed yet in the new turn.
  const lastLenRef = useRef(currentResponseLength)
  const lastGrowthAtRef = useRef<number | null>(null)
  if (currentResponseLength > lastLenRef.current) {
    lastGrowthAtRef.current = pulseNow()
  } else if (currentResponseLength < lastLenRef.current) {
    lastGrowthAtRef.current = null
  }
  lastLenRef.current = currentResponseLength

  const now = pulseNow()
  const lastEventAt = pulseOpen
    ? getPulseActivity().lastEventAt
    : lastGrowthAtRef.current
  const { stillWaiting, targetIntensity } = computeStallView({
    pulseOpen,
    phase,
    mode,
    suppressed,
    lastEventAt,
    now,
  })

  // Ease toward the target on the animation clock. Any reset (a stream event
  // arrived, or the phase left responding) snaps back instantly — the gap
  // reset is honest, only the onset is eased.
  const intensityRef = useRef(0)
  const lastSmoothAtRef = useRef(time)
  if (targetIntensity === 0 || reducedMotion) {
    intensityRef.current = targetIntensity
    lastSmoothAtRef.current = time
  } else {
    const dt = time - lastSmoothAtRef.current
    if (dt >= 50) {
      intensityRef.current = easeAttention(
        intensityRef.current,
        targetIntensity,
        dt,
        false,
      )
      lastSmoothAtRef.current = time
    }
  }

  return { stillWaiting, attentionIntensity: intensityRef.current }
}
