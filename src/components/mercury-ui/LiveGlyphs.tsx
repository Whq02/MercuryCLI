import * as React from 'react'
import { Text, useAnimationValue } from '../../ink.js'
import { useSettingsMaybe } from '../../hooks/useSettings.js'
import { useTypingPause } from '../../hooks/useTypingPause.js'
import { lerpHex } from '../../utils/theme.js'
import {
  ATTENTION_BUCKETS,
  ATTENTION_TICK_MS,
  attentionBucket,
  liveGlyphsEnabled,
  READY_BUCKETS,
  READY_TICK_MS,
  readyBucket,
  SETTLE_MS,
  TWINKLE_TICK_MS,
  twinkleBright,
  WORK_TICK_MS,
  workGlyphForTime,
} from '../../utils/cockpit/liveGlyphs.js'
import { AMBER, FAINT, IVORY } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { GLYPH } from './glyphs.js'

// ============================================================================
//  LiveGlyphs — the standing-chrome liveness primitives (schedule + gate in
//  utils/cockpit/liveGlyphs.ts, deterministically provable).
//
//  <WorkingGlyph/> — the ONE in-progress marker for pinned chrome (cockpit
//  rails, deck strip): ◐ rotates ◓◑◒ while its work is genuinely running.
//  A static ◐ everywhere else was the flatness core: "running" markers that
//  never move. Frame 0 IS GLYPH.inProgress, so every degraded state
//  (reduced-motion · MERCURY_LIVE_GLYPHS=0 · active=false) renders
//  the exact glyph the surface rendered before this primitive existed.
//
//  <AttentionPulse/> — the waiting-on-YOU treatment: text breathes
//  FAINT→AMBER on a calm 1.8s wave (quantized to buckets so equal frames
//  never commit — the BreathingDot lesson). Degraded states render steady
//  AMBER, exactly the static treatment these rows had before.
//
//  Both are for PINNED chrome that unmounts when hidden (rails/deck/strip) —
//  they deliberately skip useAnimationValue's viewport ref (Box-level, can't
//  nest inside a <Text> row); the clock still pauses when the terminal is
//  blurred, and unmount is the off-switch. Don't use these in scrollback
//  (transcript) content — that's what the viewport-ref primitives are for.
// ============================================================================

export function WorkingGlyph({
  color,
  active = true,
  tickMs = WORK_TICK_MS,
}: {
  /** The glyph color — callers keep their existing state-derived color. */
  color: string
  /** Animate only while the underlying work is actually running. */
  active?: boolean
  /** Rotation cadence. Default = the 160ms truth lattice; the streaming
   *  hold row passes the ×4 subdivision (40ms) so the one live working
   *  signal carries the paint cadence through the tail's render-invisible
   *  beats (the ux-parity 70ms p99 gap budget). Degraded states are
   *  unaffected — they render the static frame regardless of cadence. */
  tickMs?: number
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const animate = active && !reducedMotion && liveGlyphsEnabled()
  const [, glyph] = useAnimationValue(animate ? tickMs : null, time =>
    workGlyphForTime((time * WORK_TICK_MS) / tickMs),
  )
  return <Text color={color}>{animate ? glyph : GLYPH.inProgress}</Text>
}

export function AttentionPulse({
  children,
  active = true,
  bold = false,
}: {
  children: React.ReactNode
  /** Pulse only while the waiting-on-you state actually holds. */
  active?: boolean
  bold?: boolean
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const animate = active && !reducedMotion && liveGlyphsEnabled()
  const [, bucket] = useAnimationValue(
    animate ? ATTENTION_TICK_MS : null,
    attentionBucket,
  )
  const color = animate ? lerpHex(FAINT, AMBER, bucket / ATTENTION_BUCKETS) : AMBER
  return (
    <Text bold={bold} color={color}>
      {children}
    </Text>
  )
}

/** How long a changed value stays highlighted. */
const VALUE_GLOW_MS = 900

/**
 * <ValueGlow/> — live-telemetry change acknowledgment: when `value` changes
 * between renders, the text brightens to IVORY-bold for ~900ms (or `ms`),
 * then settles back to `color`. Deliberately TWO-STATE (a setTimeout, no
 * animation clock): the flash is the perception; a per-frame eased fade would
 * put a standing subscriber on chrome that idles 99% of the time. Degraded
 * states (reduced-motion · MERCURY_LIVE_GLYPHS=0) never flash —
 * they render the plain `color` text these cells rendered before.
 */
export function ValueGlow({
  value,
  color,
  children,
  ms = VALUE_GLOW_MS,
}: {
  /** The watched datum — flash when it changes (Object.is). */
  value: unknown
  /** The settled color (callers keep their state-derived color). */
  color: string
  children: React.ReactNode
  /** Flash duration override — the cursor nudge uses a snappier beat. */
  ms?: number
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const enabled = !reducedMotion && liveGlyphsEnabled()
  const prevRef = React.useRef(value)
  const [glowing, setGlowing] = React.useState(false)
  React.useEffect(() => {
    // Non-flash paths RESET the latch: a re-run for any other reason (an
    // enabled/ms flip mid-flash) has already had its un-latch timer cleared
    // by React's cleanup — without the reset the glow would strand ON.
    // Same-value setState bails, so the reset is free on the idle path.
    if (Object.is(prevRef.current, value)) {
      setGlowing(false)
      return
    }
    prevRef.current = value
    if (!enabled) {
      setGlowing(false)
      return
    }
    setGlowing(true)
    const t = setTimeout(() => setGlowing(false), ms)
    return () => clearTimeout(t)
  }, [value, enabled, ms])
  return (
    <Text bold={glowing} color={glowing ? IVORY : color}>
      {children}
    </Text>
  )
}

/**
 * <ReadyBreath/> — the ambient "alive at rest" tier (the hero `● ready` dot's
 * idiom, promoted): text swells `deep`→`to` on the slow READY wave while the
 * surface is genuinely ready-and-idle. The ONE sanctioned standing motion for
 * an idle REPL — identity-toned (the caller passes its session-accent pair),
 * never a status hue, so it can't cry wolf. Degraded states (inactive ·
 * reduced-motion · MERCURY_LIVE_GLYPHS=0) render steady `to` —
 * exactly the static cell the surface rendered before.
 */
export function ReadyBreath({
  deep,
  to,
  children,
  active = true,
  dim = false,
}: {
  /** The trough color — the caller's accentDeep (never fully FAINT: a dark
   *  ember still reads as identity, not as "disabled"). */
  deep: string
  /** The crest color AND the settled/degraded color — the caller's accent. */
  to: string
  children: React.ReactNode
  /** Breathe only while genuinely ready-and-idle (empty prompt, no turn). */
  active?: boolean
  /** Pass-through for callers that dim the settled glyph (loading caret). */
  dim?: boolean
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  // DECOR tier: decoration pauses while the operator types (the S2 motion
  // hierarchy) — the paused state renders the settled `to` color, exactly
  // the degraded-state cell.
  const typing = useTypingPause()
  const animate = active && !reducedMotion && !typing && liveGlyphsEnabled()
  const [, bucket] = useAnimationValue(animate ? READY_TICK_MS : null, readyBucket)
  const color = animate ? lerpHex(deep, to, bucket / READY_BUCKETS) : to
  return (
    <Text color={color} dimColor={dim}>
      {children}
    </Text>
  )
}

/**
 * <TwinkleSpark/> — the standing brand mark's glint: renders the identity ✶
 * in `color`, flashing to the bright ✦ form (the DERIVED accent-bloom since
 * the crab keeps its authored coral byte-equal; others glint their own
 * bloom) for one brief beat per ~9s cycle. Ambient-presence tier, for brand
 * furniture only (the inline sigil) — never for status cells. Degraded states
 * render the plain ✶ in `color`, byte-identical to the pre-primitive cell.
 */
export function TwinkleSpark({
  color,
  active = true,
}: {
  /** The settled spark color (callers pass their identity accent). */
  color: string
  active?: boolean
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const { accentSoft } = useMercuryTokens()
  // DECOR tier: the brand glint rests while the operator types (S2).
  const typing = useTypingPause()
  const animate = active && !reducedMotion && !typing && liveGlyphsEnabled()
  const [, bright] = useAnimationValue(animate ? TWINKLE_TICK_MS : null, twinkleBright)
  const glint = animate && bright
  return <Text color={glint ? accentSoft : color}>{glint ? GLYPH.sparkBright : GLYPH.spark}</Text>
}

/**
 * useSettleFlash — the ember-settle latch: true for SETTLE_MS after `settled`
 * flips false→true, so a resolving mark can bloom GLYPH.spark before settling
 * into its final state glyph. Transition-edge only: a row that MOUNTS already
 * settled (scrollback re-render, resume) never flashes — only live completions
 * bloom. Degraded states (reduced-motion · MERCURY_LIVE_GLYPHS=0)
 * never latch.
 */
export function useSettleFlash(settled: boolean): boolean {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const enabled = !reducedMotion && liveGlyphsEnabled()
  const prevRef = React.useRef(settled)
  const [flash, setFlash] = React.useState(false)
  React.useEffect(() => {
    const was = prevRef.current
    prevRef.current = settled
    if (!enabled || was || !settled) {
      // Non-transition re-runs (an enabled flip, a settled bounce) have had
      // their un-latch timer cleared by React's cleanup — reset the latch so
      // a flash can never strand ON. Same-value setState bails (free).
      setFlash(false)
      return
    }
    setFlash(true)
    const t = setTimeout(() => setFlash(false), SETTLE_MS)
    return () => clearTimeout(t)
  }, [settled, enabled])
  return flash
}

/**
 * <CursorCell/> — the ▸ in-row selection cursor with a landing nudge: the
 * cursor cell flashes IVORY-bold for a snappy beat as focus LANDS on its row
 * (ValueGlow keyed on `focused` — the blur-edge flash paints spaces, so only
 * the landing is visible). Always render it (focused or not) so the mount is
 * stable and the edge is observable; the blurred cell is the same two spaces
 * these hand-rolled rows rendered before. Degraded states never flash.
 */
export const CURSOR_NUDGE_MS = 380

export function CursorCell({
  focused,
  color,
}: {
  focused: boolean
  /** The settled cursor color (callers pass their accent). */
  color: string
}): React.ReactNode {
  return (
    <ValueGlow value={focused} color={color} ms={CURSOR_NUDGE_MS}>
      {focused ? `${GLYPH.cursor} ` : '  '}
    </ValueGlow>
  )
}
