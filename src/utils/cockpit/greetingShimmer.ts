// ============================================================================
//  utils/cockpit/greetingShimmer — the React-free TIMING for the identity
//  ramp's GREETING SHIMMER.
//
//  Same split as liveGlyphs.ts: pure clock-value-in → phase-out math, no
//  React/ink/theme imports, so proofs table-test the schedule instead of
//  racing a live PTY. mercury-ui/useGreetingShimmer.ts is the React consumer;
//  focalRamp.ts applies the phase to segment colours; the splash core
//  hand-mirrors this block (SPLASH-GLOW markers) and
// scripts/splash/prove-ramp-parity.ts pins the mirror byte-for-byte.
//
//  THE SETTLE LAW (the operator's refinement): the shimmer is a GREETING,
//  not a loop. On first open of a surface (or first selection of a row) the
//  ramp's bright band ping-pongs left→right→left for ~10 s, eases out, and
//  SETTLES into the exact static gradient the surface renders today. A
//  re-open / re-select starts a fresh greeting. Settled, closed, unselected,
//  reduced-motion, or single-stop ⇒ zero animation, zero repaint cost — the
//  phase law returns its terminal token and the consumer drops its clock
//  subscription (subscriber-counted timers, the LiveGlyphs contract).
//
//  THE SWEEP: a raised-cosine light band travels the span on a cosine-eased
//  ping-pong (slowing into the ends — the turnarounds read deliberate).
//  Cells inside the band sample the ramp AHEAD toward its ink stop
//  (focalRamp boosts u, never a foreign hue), so the shimmer IS the
//  gradient's own bloom sweeping across the text — and cells outside the
//  band render the settled sample byte-exactly, so per-tick damage is the
//  band's handful of cells, never a full-row repaint storm.
//
//  MOTION HIERARCHY: the greeting samples on the FOCAL 80 ms lane — the
//  nested 80 ⊂ 160 ⊂ 320 clock family (the liveGlyphs motion hierarchy),
//  amended: FOCAL carries the ONE standing live-edge element
//  (the spinner) plus this TRANSIENT identity greeting, which is bounded
//  (≤ SHIMMER_GREETING_MS per arm) and drops its subscription at settle.
//  Frame 0 (ease-in from 0) IS the static cell — the frame-0 degradation
//  invariant every motion primitive here holds. The phase KEY quantizes
//  (whole-cell peak × gain level), so equal frames never commit.
// ============================================================================

/** Sampling cadence — the FOCAL lane of the nested clock family. */
export const SHIMMER_TICK_MS = 80
/** The greeting window: ping-pong for ~10 s, then settle forever. */
export const SHIMMER_GREETING_MS = 10_000
/** Ease-in: the band fades up from the settled frame (no arrival pop). */
export const SHIMMER_EASE_IN_MS = 350
/** Ease-out: the last stretch fades the band back into the settled frame. */
export const SHIMMER_EASE_OUT_MS = 1500
/** One sweep leg (L→R or R→L) scales with the span — a wide banner sweeps
 *  majestically, a 7-cell wordmark stays calm rather than frantic. */
export const SHIMMER_LEG_MS_PER_CELL = 55
export const SHIMMER_LEG_MIN_MS = 1300
export const SHIMMER_LEG_MAX_MS = 3200
/** Peak boost toward the ramp's ink stop (u' = u + lift·w·(1−u)). */
export const SHIMMER_LIFT = 0.85
/** Gain quantization levels (equal buckets never commit). */
export const SHIMMER_GAIN_LEVELS = 5

/** The band radius for a span, in cells. */
export function shimmerRadius(spanCells: number): number {
  return Math.max(3, Math.min(8, Math.round(spanCells * 0.28)))
}

/** One ping-pong leg duration for a span. */
export function shimmerLegMs(spanCells: number): number {
  return Math.max(
    SHIMMER_LEG_MIN_MS,
    Math.min(SHIMMER_LEG_MAX_MS, spanCells * SHIMMER_LEG_MS_PER_CELL),
  )
}

export type ShimmerPhase = {
  /** Band centre, whole cells (may sit anywhere in [0, span-1]). */
  peakCell: number
  /** Quantized envelope gain, 1..SHIMMER_GAIN_LEVELS. */
  gainLevel: number
  /** Band radius in cells (shimmerRadius(span)). */
  radiusCells: number
}

/** The envelope: 0 at t≤0, eased 0→1 over EASE_IN, 1 through the middle,
 *  eased 1→0 over the final EASE_OUT, 0 at ≥ GREETING (settled). */
export function shimmerEnvelope(elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= SHIMMER_GREETING_MS) return 0
  const easeOutStart = SHIMMER_GREETING_MS - SHIMMER_EASE_OUT_MS
  if (elapsedMs < SHIMMER_EASE_IN_MS) {
    const x = elapsedMs / SHIMMER_EASE_IN_MS
    return x * x // ease-in-quad: rises gently off the settled frame
  }
  if (elapsedMs > easeOutStart) {
    const x = (SHIMMER_GREETING_MS - elapsedMs) / SHIMMER_EASE_OUT_MS
    return x * x // mirrored: sinks gently back into the settled frame
  }
  return 1
}

/** Band centre position (cells, unquantized) at an elapsed time: a cosine
 *  ping-pong over [0, span-1] — starts at the LEFT edge, sweeps right, turns
 *  smoothly, sweeps back; period = 2 legs. */
export function shimmerPeakAt(elapsedMs: number, spanCells: number): number {
  if (spanCells <= 1) return 0
  const leg = shimmerLegMs(spanCells)
  const tau = (elapsedMs % (2 * leg)) / (2 * leg) // 0..1 over one ping-pong
  return ((1 - Math.cos(tau * 2 * Math.PI)) / 2) * (spanCells - 1)
}

/** The settled terminal token — the consumer drops its clock on this. */
export const SHIMMER_SETTLED = 'settled'

/** The RENDERED phase key at an elapsed time: quantized so equal frames
 *  never commit; SHIMMER_SETTLED once the greeting window has passed. A
 *  zero-gain key ('g0', the ease-in's first instants) renders byte-equal to
 *  the settled frame but keeps the clock — the greeting is still coming. */
export function shimmerPhaseKey(elapsedMs: number, spanCells: number): string {
  if (elapsedMs >= SHIMMER_GREETING_MS) return SHIMMER_SETTLED
  const gainLevel = Math.round(shimmerEnvelope(elapsedMs) * SHIMMER_GAIN_LEVELS)
  if (gainLevel <= 0) return 'g0'
  const peakCell = Math.round(shimmerPeakAt(elapsedMs, spanCells))
  return `${peakCell}:${gainLevel}`
}

/** Parse a phase key back into a ShimmerPhase (null for settled/zero-gain —
 *  the render path treats null as "paint the plain settled ramp"). */
export function shimmerPhaseOf(key: string, spanCells: number): ShimmerPhase | null {
  if (key === SHIMMER_SETTLED || key === 'g0') return null
  const sep = key.indexOf(':')
  if (sep <= 0) return null
  const peakCell = Number(key.slice(0, sep))
  const gainLevel = Number(key.slice(sep + 1))
  if (!Number.isFinite(peakCell) || !Number.isFinite(gainLevel) || gainLevel <= 0) return null
  return { peakCell, gainLevel, radiusCells: shimmerRadius(spanCells) }
}

/** The per-cell boost fraction (0..1) a phase applies at a cell centre:
 *  raised-cosine falloff over the band radius × the quantized gain × LIFT.
 *  Exactly 0 outside the band — those cells render the settled sample
 *  byte-for-byte, which is what bounds per-tick damage to the band. */
export function shimmerBoostAt(cellCenter: number, phase: ShimmerPhase): number {
  const d = Math.abs(cellCenter - phase.peakCell)
  if (d >= phase.radiusCells) return 0
  const w = Math.cos((d / phase.radiusCells) * (Math.PI / 2))
  return SHIMMER_LIFT * (phase.gainLevel / SHIMMER_GAIN_LEVELS) * w * w
}
