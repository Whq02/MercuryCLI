import { flagEnv } from '../../substrate/flagRegistry.js'
// ============================================================================
//  utils/cockpit/liveGlyphs — the React-free TIMING for the standing-chrome
//  live indicators (mercury-ui/LiveGlyphs.tsx draws them).
//
//  Same split as critterIdle.ts: pure clock-value-in → frame-out math with the
//  stamp gate, no React/ink/theme imports, so proofs can table-test the
//  schedule deterministically instead of racing a live PTY.
//
//  Two indicators:
//  · WORK — the in-progress marker (◐) ROTATES through its quarter-moon
//    siblings while work is genuinely running. One glyph cell, geometric
//    shapes only (the same U+25D0-family cell the status spine already uses —
//    NOT emoji), so a static render is byte-compatible: frame 0 IS ◐.
//  · ATTENTION — the waiting-on-YOU pulse: a 0→1→0 wave the view lerps
//    FAINT→AMBER with, quantized to buckets so equal frames don't commit
//    (the BreathingDot lesson: a continuous wave = a fresh hex every tick).
//
//  THE MOTION HIERARCHY — three tiers, one
//  nested clock family (80 ⊂ 160 ⊂ 320: absolute-bucket sampling means every
//  coarser edge coincides with a finer one, so coincident advances batch
//  into ONE compose):
//    · FOCAL (FOCAL_TICK_MS 80) — ONE standing element: the live-edge
//      spinner (the hero-bubble spinner in cockpit / the spinner row in
//      transcript). Its requesting glimmer rides this lane — an
//      off-lattice 50ms clock that never shared an edge with anything.
//      GLOW amendment: the identity ramp's TRANSIENT greeting
//      shimmer (utils/cockpit/greetingShimmer.ts) samples this lane too —
//      bounded (≤ ~10 s per arm), subscriber-counted, and its clock drops
//      at settle, so the standing-element census is unchanged at rest.
//    · TRUTH (the 160 lattice) — state-carrying indicators: tool-mark
//      breath + rotation, rails WorkingGlyph, ATTENTION. Truth never pauses
//      and never demotes; its tempo is the shared WORK_TICK_MS.
//    · DECOR (the typing pause + the coarsest LOSSLESS sampling) — presence
//      decoration: READY caret breath, TWINKLE brand glint. Both PAUSE
//      entirely while the operator types (utils/cockpit/typingActivity.ts):
//      while you type, your own words are the only motion on screen.
//      Sampling is per-primitive at the coarsest tick that skips no rendered
//      step: TWINKLE 320 (glint 340ms > one sample), READY 160 (min bucket
//      dwell 273ms forbids 320 — the dwell law, prover-pinned).
// ============================================================================


/** Quarter-moon rotation, frame 0 = the static GLYPH.inProgress ◐. */
export const WORK_FRAMES = ['◐', '◓', '◑', '◒'] as const
/** Rotation cadence — slow enough to read calm, fast enough to read alive. */
export const WORK_TICK_MS = 160

/** FOCAL cadence — the ONE live-edge element (the active spinner). Divides
 *  the 160ms truth lattice, so focal advances share clock edges with every
 *  ambient sampler (absolute-bucket sampling) and coincident commits batch
 *  into one compose. Chosen over the old off-lattice 50ms requesting clock:
 *  measured 50/80/160 — 80 keeps the pre-first-token sweep fluid at 12.5
 *  samples/s while cutting its commit rate ~1.6× and phase-locking it. */
export const FOCAL_TICK_MS = 80

/** DECOR cadence — presence decoration (READY breath · TWINKLE glint).
 *  2× the truth lattice: both waves dwell ≥340ms per rendered step, so a
 *  320ms sampler loses nothing visible while halving standing-idle timer
 *  wakes. Decoration also pauses while typing (typingActivity.ts). */
export const DECOR_TICK_MS = 320

export function workGlyphForTime(time: number): string {
  const idx = Math.floor(time / WORK_TICK_MS) % WORK_FRAMES.length
  return WORK_FRAMES[idx < 0 ? 0 : idx] as string
}

/** Attention pulse period (ms) — a calm breath, not an alarm strobe. */
export const ATTENTION_PERIOD = 1800
/** Sample cadence for the pulse — on the shared 160ms motion lattice (REPL
 *  smoothness pass: every standing-chrome sampler ticks at 160ms =
 *  WORK_TICK_MS, so with absolute-bucket sampling concurrent animations trip
 *  on the SAME clock tick and batch into one compose; bucket dwell ≈180ms so
 *  160ms sampling loses nothing visible). */
export const ATTENTION_TICK_MS = 160
/** Quantization buckets (0..ATTENTION_BUCKETS inclusive). */
export const ATTENTION_BUCKETS = 5

// --- READY breath — the ambient "alive at rest" tier -----------------------
// The hero's `● ready` idiom promoted to a shared schedule: a slow deep→accent
// swell for the ONE glyph that means "Mercury is listening" (the prompt caret
// while the REPL is idle and the buffer is empty). Deliberately slower than
// ATTENTION (3.4s vs 1.8s) and identity-toned at the call site, so it reads as
// presence, never as a demand. Quantized like the others so equal frames never
// commit (~2.4 commits/s worst-case — under the accepted BreathingDot budget).
export const READY_PERIOD = 3400
/** READY stays on the 160 lattice: its MIN bucket dwell is 273ms (the sine's
 *  steep midpoint — the ≈425ms figure is the average), so a 320ms sampler
 *  would skip a rendered step once per breath. Decor-TIER for the typing
 *  pause, truth-LATTICE for sampling (prove-motion-hierarchy pins the
 *  dwell law per primitive). */
export const READY_TICK_MS = 160
export const READY_BUCKETS = 4

/** Smooth 0→1→0 ready wave over READY_PERIOD (sin eased, starts at 0). */
export function readyWave(time: number): number {
  const phase = ((time % READY_PERIOD) + READY_PERIOD) % READY_PERIOD
  return (Math.sin((phase / READY_PERIOD) * Math.PI * 2 - Math.PI / 2) + 1) / 2
}

/** Quantized ready level — the RENDERED value (equal buckets never commit). */
export function readyBucket(time: number): number {
  return Math.round(readyWave(time) * READY_BUCKETS)
}

// --- TWINKLE — the standing brand glint ------------------------------------
// The ✶ identity spark flashes to its bright ✦ form for one brief beat per
// cycle, the star-family sibling of the hero blink. The glint sits at MID
// cycle so time 0 renders the plain ✶ — the frame-0 static-degradation
// invariant every primitive here holds.
export const TWINKLE_CYCLE = 9200
export const TWINKLE_MS = 340 // ≥ DECOR_TICK_MS + margin: a 320ms sampler can never skip the glint
export const TWINKLE_TICK_MS = DECOR_TICK_MS // decor tier

/** True only during the brief mid-cycle glint beat. twinkleBright(0) is false. */
export function twinkleBright(time: number): boolean {
  const phase = ((time % TWINKLE_CYCLE) + TWINKLE_CYCLE) % TWINKLE_CYCLE
  const at = TWINKLE_CYCLE / 2
  return phase >= at && phase < at + TWINKLE_MS
}

// --- SETTLE — the ember-settle event ----------------------------------------
// The one-shot ✶ bloom a resolving tool mark renders before settling into its
// final state glyph ("watch the work land"). A transition EVENT, not a standing
// animation: consumers latch it with a setTimeout (the ValueGlow two-state
// pattern), so scrollback stays still and only LIVE completions bloom.
export const SETTLE_MS = 320

/** Smooth 0→1→0 wave over ATTENTION_PERIOD (sin eased, starts at 0). */
export function attentionWave(time: number): number {
  const phase = ((time % ATTENTION_PERIOD) + ATTENTION_PERIOD) % ATTENTION_PERIOD
  return (Math.sin((phase / ATTENTION_PERIOD) * Math.PI * 2 - Math.PI / 2) + 1) / 2
}

/** Quantized pulse level — the RENDERED value (equal buckets never commit). */
export function attentionBucket(time: number): number {
  return Math.round(attentionWave(time) * ATTENTION_BUCKETS)
}

/** Gate: stamp-only, `MERCURY_LIVE_GLYPHS=0` hard-off (mirrors critterIdle). */
export function liveGlyphsEnabled(): boolean {
  return flagEnv('MERCURY_LIVE_GLYPHS') === '0' ? false : true
}
