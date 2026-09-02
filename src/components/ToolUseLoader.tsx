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

const BREATH_PERIOD_MS = 1920;
const BREATH_STEP_MS = 160;
type Props = {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
  isRead?: boolean;
  isDenied?: boolean;
};
export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
  isRead,
  isDenied,
}: Props): React.ReactNode {
  const [ref, isBlinking] = useBlink(false);
  const { accentSoft } = useMercuryTokens();
  const reducedMotion = useSettings().prefersReducedMotion ?? false;
  const focused = useTerminalFocus();
  const breathing =
    isUnresolved && !isError && shouldAnimate && !reducedMotion && focused;
  const [breathRef, breathTime] = useAnimationValue(
    breathing ? BREATH_STEP_MS : null,
    t => Math.floor(t / BREATH_STEP_MS) * BREATH_STEP_MS,
  );
  const settleFlash = useSettleFlash(!isUnresolved);

  const color = isUnresolved ? undefined : isError ? 'error' : 'success';

  if (isUnresolved && !isError) {
    const t = breathing
      ? (1 - Math.cos((2 * Math.PI * breathTime) / BREATH_PERIOD_MS)) / 2
      : 0;
    const pulse = breathing ? lerpHex(FAINT, TEAL, t) : FAINT;
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
    return (
      <Box ref={ref} minWidth={2}>
        <Text bold={settleFlash} color={isDenied ? 'error' : 'warning'}>
          {isDenied ? GLYPH.fail : GLYPH.warn}
        </Text>
      </Box>
    );
  }

  if (!isUnresolved && !isError && !isRead && settleFlash) {
    return (
      <Box ref={ref} minWidth={2}>
        <Text bold color={accentSoft}>{GLYPH.spark}</Text>
      </Box>
    );
  }

  if (!isUnresolved && isRead) {
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