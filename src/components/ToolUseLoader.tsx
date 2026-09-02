import React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { GLYPH } from './mercury-ui/glyphs.js';
import { FAINT, TEAL } from './mercuryPalette.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useBlink } from '../hooks/useBlink.js';
import { useSettings } from '../hooks/useSettings.js';
import { lerpHex } from '../utils/theme.js';
import { liveGlyphsEnabled, workGlyphForTime } from '../utils/cockpit/liveGlyphs.js';
import { useSettleFlash } from './mercury-ui/LiveGlyphs.js';
import { Box, Text, useAnimationValue, useTerminalFocus } from '../ink.js';

// The in-progress breath: one full FAINT→TEAL→FAINT cycle per period. A
// cos-eased lerp (not useBlink's 50% square wave) so several concurrent tool
// cards read as a calm shared breath, not a strobe (trust-cockpit W4).
//
// REPL smoothness pass: the period is 12 × the shared 160ms
// motion lattice (WORK_TICK_MS) and the clock is QUANTIZED to that lattice —
// the breath color and the ◐◓◑◒ rotation now step on the SAME edges, so a
// running row commits ~6.3×/s (one compose per shared edge) instead of the
// old raw-80ms tick's ~12.5 fresh-hex commits+writes/s (the BreathingDot
// lesson: a continuous wave = a fresh hex every tick). 12 color steps across
// the small FAINT→TEAL distance are indistinguishable from the continuous
// lerp; every concurrent card still breathes in unison (shared clock time).
const BREATH_PERIOD_MS = 1920;
const BREATH_STEP_MS = 160;
type Props = {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
  /** Fork: a resolved, non-error file READ leads with the ◌ "scanned" ring
   *  (success TEAL) instead of the filled ● done-dot, so a read reads distinctly
   *  from a mutating write/edit. */
  isRead?: boolean;
  /** Fork: the CRIMSON ✕ is reserved for DENIALS —
   *  a rejected permission, an interrupt, a kill. An errored-but-not-denied
   *  tool (a failing bash command is ordinary work) wears the AMBER ▲ warn
   *  lead instead, per the status spine. Only read when isError is true. */
  isDenied?: boolean;
};
// Hand-written (no React-Compiler `_c` memo cache) so the
// renderer can show a STEADY ◐ for the in-progress (unresolved, non-error) state
// instead of the default's blink-to-blank. State is honest: isUnresolved/isError come
// from AssistantToolUseMessage's resolved/errored ID sets. Glyph meaning:
// ◐ running (FAINT) · ● done (success=TEAL via theme) · ● error (CRIMSON).
// The chalk dim+bold reset collision (see history) is avoided: a single <Text>,
// no adjacent bold sibling sharing the \x1b[22m reset.
export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
  isRead,
  isDenied,
}: Props): React.ReactNode {  // The blink square-wave is only VISIBLE on the plain fallback return —
  // every Mercury branch below renders its own glyph and ignores isBlinking —
  // so Mercury never pays its clock subscription (all hooks unconditional).
  const [ref, isBlinking] = useBlink(false);
  // The DERIVED accent-bloom for the ember-settle spark (unconditional hook).
  const { accentSoft } = useMercuryTokens();
  // Fork breath clock (all hooks unconditional): a QUANTIZED shared frame that
  // every concurrent card derives the SAME phase from (time is global, so
  // simultaneous loaders breathe in unison). Reduced-motion / unfocused /
  // animation-off resolve the clock to null ⇒ zero timers, steady FAINT.
  // useAnimationValue returns the 160ms-stepped instant, so a card re-renders
  // only when the step (= breath color AND rotation frame) actually advances.
  const reducedMotion = useSettings().prefersReducedMotion ?? false;
  const focused = useTerminalFocus();
  const breathing =
    isUnresolved && !isError && shouldAnimate && !reducedMotion && focused;
  const [breathRef, breathTime] = useAnimationValue(
    breathing ? BREATH_STEP_MS : null,
    t => Math.floor(t / BREATH_STEP_MS) * BREATH_STEP_MS,
  );
  // The ember-settle latch (LiveGlyphs): true for one ~320ms beat after THIS
  // mount observes the live unresolved→resolved edge. Rows that mount already
  // settled (scrollback re-render, resume) never latch — only work you watch
  // land blooms. Gated inside the hook (reduced-motion · MERCURY_LIVE_GLYPHS=0
  // ⇒ always false).
  const settleFlash = useSettleFlash(!isUnresolved);

  // Resolved → success/error dot; unresolved → dim. Unchanged.
  const color = isUnresolved ? undefined : isError ? 'error' : 'success';

  if (isUnresolved && !isError) {
    // In-progress: ◐ BREATHES between FAINT (dim) and TEAL (the FIXED
    // in-progress status spine — running is STATUS, never the session accent)
    // while the tool runs — a cos-eased lerp, the design-system answer both to
    // the old blink-to-blank and to the old 2-state square-wave snap that
    // read as flicker with several concurrent tools. The glyph never
    // disappears; only its colour breathes. Steady FAINT when animation is
    // off, reduced-motion is set, or the terminal is unfocused.
    const t = breathing
      ? (1 - Math.cos((2 * Math.PI * breathTime) / BREATH_PERIOD_MS)) / 2
      : 0;
    const pulse = breathing ? lerpHex(FAINT, TEAL, t) : FAINT;
    // Rotation: the transcript's running mark speaks the SAME motion idiom as
    // the rails' WorkingGlyph — ◐◓◑◒ off the shared schedule, derived from the
    // breath clock it already rides — so "running" moves identically everywhere.
    // Degraded states render the steady static ◐ these rows always rendered.
    const glyph =
      breathing && liveGlyphsEnabled()
        ? workGlyphForTime(breathTime)
        : GLYPH.inProgress;
    return (
      <Box ref={breathRef} minWidth={2}>
        <Text color={pulse}>{glyph}</Text>
      </Box>
    );
  }

  if (isError) {
    // The error family splits on DENIAL: a rejected
    // permission / interrupt / kill leads with the CRIMSON ✕ — the operator
    // said no, the transcript should say so loudly. A tool that merely
    // ERRORED (non-zero bash exit, a failed fetch) is ordinary work-in-
    // progress: it wears the AMBER ▲ warn lead so half the transcript never
    // reads as failure. Its own early return keeps the dim+bold chalk-reset
    // handling off the error path. A LIVE failure lands with one bold beat
    // (the settle latch) — no spark, errors don't celebrate.
    return (
      <Box ref={ref} minWidth={2}>
        <Text bold={settleFlash} color={isDenied ? 'error' : 'warning'}>
          {isDenied ? GLYPH.fail : GLYPH.warn}
        </Text>
      </Box>
    );
  }

  if (!isUnresolved && !isError && !isRead && settleFlash) {
    // The ember-settle: a just-landed MUTATING tool blooms the identity spark
    // (bold accent-BLOOM — derived from the LIVE accent since, so an
    // octopus session blooms violet, not crab-coral; the crab keeps BELLY
    // byte-equal) for one beat before settling into the plain ● success dot.
    // Reads stay quiet (◌ simply appears) so a spark always MEANS "a change
    // landed"; read-heavy turns never strobe.
    return (
      <Box ref={ref} minWidth={2}>
        <Text bold color={accentSoft}>{GLYPH.spark}</Text>
      </Box>
    );
  }

  if (!isUnresolved && isRead) {
    // Resolved file read: the non-mutating ◌ "scanned" ring (success=TEAL) in
    // place of the filled ● done-dot. Error already returned above, so ✕ stays
    // reserved for failed/errored tool calls only.
    return (
      <Box ref={ref} minWidth={2}>
        <Text color="success">{GLYPH.read}</Text>
      </Box>
    );
  }

  const glyph =
    !shouldAnimate || isBlinking || isError || !isUnresolved
      ? BLACK_CIRCLE
      : ' ';
  return (
    <Box ref={ref} minWidth={2}>
      <Text color={color} dimColor={isUnresolved}>
        {glyph}
      </Text>
    </Box>
  );
}