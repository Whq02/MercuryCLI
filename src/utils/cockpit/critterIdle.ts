import { flagEnv } from '../../substrate/flagRegistry.js'
import { SLEEP_PHASES, SWAY_PHASES } from './critterData.js'
// ============================================================================
//  utils/cockpit/critterIdle — the React-free TIMING + GATE for the home splash's
//  living mascot (AnimatedCritterArt / BreathingDot draw it).
//
//  Split out from the view for the same reason critterData is: it's pure (a clock
//  value in, a glyph / 0..1 wave out, plus Mercury+env gate) so it imports only
//  the Mercury flag — no React, no ink, no theme — and a proof can assert the blink
//  SCHEDULE deterministically instead of racing a live PTY for a 150ms frame.
// ============================================================================


// The pupil glyph swapped per frame (the ONLY thing the idle loop changes — the
// `.art` grid, hues, eye-white, and layout are untouched, so OFF ⇒ identical).
export const EYE_OPEN = '●' // forward-gaze iris dot (CritterArt's own default)
export const EYE_SHUT = '—' // a flat lid in the same oasis-on-ivory eye cell

// Idle cadence (ms): one quick blink near the top of each cycle, with an
// occasional double-blink — slow enough to read as calm, not a tic.
export const BLINK_CYCLE = 5200
export const LID_MS = 150
export const SECOND_LID_AT = 280
export const BREATH_PERIOD = 2800
// Frame intervals — fast enough to catch the lid crisply / breathe smoothly,
// slow enough to stay cheap (the viewport-pause stops both off-screen anyway).
export const IDLE_TICK_MS = 80
export const BREATH_TICK_MS = 120

export function critterIdleEnabled(): boolean {
  // Mirror experienceCardsEnabled(): explicit "=0" hard-off, else stamp-gated.
  return flagEnv('MERCURY_CRITTER_IDLE') === '0' ? false : true
}

// Forward-gaze most of the cycle; a brief lid at the top, plus a double-blink
// every 4th cycle. A continuous loop ⇒ no mount-offset bookkeeping needed.
export function pupilForTime(time: number): string {
  const phase = time % BLINK_CYCLE
  const doubleBlink = Math.floor(time / BLINK_CYCLE) % 4 === 3
  const shut =
    phase < LID_MS || (doubleBlink && phase >= SECOND_LID_AT && phase < SECOND_LID_AT + LID_MS)
  return shut ? EYE_SHUT : EYE_OPEN
}

// ── IDLE FLOW + SLEEP cadences ────────────────────────

/** Awake: one sway phase per this many ms. Slow enough to read as drifting in
 *  water rather than vibrating; with the eight-phase cycle a flowing critter
 *  commits ~1.4 frames/s while it is actually on screen. */
export const SWAY_TICK_MS = 700

/** Asleep: the same undulation, THREE times slower — a sleeping creature that
 *  keeps drifting at its waking pace does not read as asleep. This is the
 *  "settle": at the sleep edge the motion drops to breathing and the lid
 *  closes, and only then does the Zzz start to rise. */
export const SLEEP_SWAY_TICK_MS = SWAY_TICK_MS * 3

/** Asleep: one Zzz phase per this many ms. */
export const SLEEP_TICK_MS = 900

// ── sway-phase CONTINUITY across the sleep boundary ──────
//  The waking and sleeping sways run at different cadences, and deriving each
//  as an independent wall-clock modulo made the extremities TELEPORT up to two
//  columns at every verdict flip (the phase re-sampled under the new divisor).
//  An anchor pins the phase THAT WAS SHOWING at the last flip; both cadences
//  count steps from it, so a transition changes only the SPEED of the drift,
//  never its position. critterSleep.ts owns the anchor (it owns the flips);
//  everything here stays pure-from-arguments so the prover can walk a
//  transition on a pinned clock.

export type SwayAnchor = { phase: number; at: number }

/** The boot anchor — phase 0 at epoch 0. With it, `swayPhaseAt` is exactly the
 *  historical wall-clock modulo in both cadences, so anchor-less callers (and
 *  the provers' two-argument calls) are byte-identical to the old schedule. */
export const ZERO_SWAY_ANCHOR: SwayAnchor = { phase: 0, at: 0 }

/** The sway phase at `time`, counting whole ticks of the current cadence from
 *  the anchor. Total: a `time` before the anchor holds the anchored phase. */
export function swayPhaseAt(
  time: number,
  asleep: boolean,
  anchor: SwayAnchor = ZERO_SWAY_ANCHOR,
): number {
  const tick = asleep ? SLEEP_SWAY_TICK_MS : SWAY_TICK_MS
  const steps = Math.floor(Math.max(0, time - anchor.at) / tick)
  return (((anchor.phase + steps) % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES
}

/**
 * THE frame key — pupil · sway phase · sleep phase, packed into three
 * characters so a mount needs exactly ONE clock subscription (and therefore
 * one viewport-pause ref, which is the real constraint: useAnimationValue
 * hands back the ref that gates it, and only one ref can own the box).
 * Deriving inside the subscription means the shared clock's ticks commit only
 * on an OUTPUT edge — a blink lid, a sway step, or a Zzz step — never on the
 * ~12 ticks a second that change nothing.
 *
 * `anchor` keeps the sway phase continuous across sleep/wake (above), and
 * `sleepSince` starts the Zzz STORY at its first phase on the night the
 * critter actually fell asleep — the z rises, builds, and drifts from the
 * beginning instead of joining a wall-clock loop mid-cycle.
 *
 * Awake → `<pupil><sway>-` (no sleep phase)
 * Asleep → `<lid><sway><zzz>` (lid is always shut; sway is the slow breath)
 */
export function critterFrameKey(
  time: number,
  asleep: boolean,
  anchor: SwayAnchor = ZERO_SWAY_ANCHOR,
  sleepSince = 0,
): string {
  const sway = swayPhaseAt(time, asleep, anchor)
  if (asleep) {
    const zzz =
      Math.floor(Math.max(0, time - sleepSince) / SLEEP_TICK_MS) % SLEEP_PHASES
    return `${EYE_SHUT}${sway}${zzz}`
  }
  return `${pupilForTime(time)}${sway}-`
}

/** Unpack a `critterFrameKey`. Total over every key the function produces; a
 *  malformed key degrades to the authored rest frame rather than throwing. */
export function readCritterFrameKey(key: string): {
  pupil: string
  swayPhase: number
  sleepPhase: number | null
} {
  const pupil = key[0] ?? EYE_OPEN
  const sway = Number.parseInt(key[1] ?? '0', 10)
  const zc = key[2] ?? '-'
  const zzz = zc === '-' ? null : Number.parseInt(zc, 10)
  return {
    pupil,
    swayPhase: Number.isFinite(sway) ? sway : 0,
    sleepPhase: zzz !== null && Number.isFinite(zzz) ? zzz : null,
  }
}

// A smooth 0→1→0 breath wave for the `● ready` dot. The caller lerps existing
// tokens with it (no new hex); kept here as pure math so it's provable.
export function breathWave(time: number): number {
  const phase = (time % BREATH_PERIOD) / BREATH_PERIOD
  return (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2
}

// Quantized breath level — the RENDERED value. The continuous wave produces a
// new lerp hex nearly every 120ms tick (~8 commits/s for a 1-cell dot, and
// each idle commit costs a full compose). 6 buckets = 7 shades over the
// dim-teal→teal span → 12 bucket-edge crossings per 2.8s period ≈ 4.3
// commits/s, half the raw tick rate, visually indistinguishable at 1 cell.
// Consumed by BreathingDot via useAnimationValue so equal buckets don't
// commit at all.
export const BREATH_BUCKETS = 6
export function breathBucket(time: number): number {
  return Math.round(breathWave(time) * BREATH_BUCKETS)
}
