import * as React from 'react';
import { Box, Text, useTheme } from '../../ink.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { STILL_WAITING_MAX_INTENSITY } from './useStalledAnimation.js';
import { getDefaultCharacters, interpolateColor, parseRGB, toRGBColor } from './utils.js';

// Hand-written (no React-Compiler `_c` memo cache).
const DEFAULT_CHARACTERS = getDefaultCharacters();
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
const REDUCED_MOTION_DOT = '●';
const REDUCED_MOTION_CYCLE_MS = 2000; // one full breath every two seconds — half bright, half dim

// Quicksilver-cadence swing map (main-vocab pass, renamed with the
// mercury-native re-cut): an 8-tick bar that HOLDS the downbeat
// then rushes the back half — the glyph "nods" instead of rotating evenly.
// The bar advances 6 frames per 8 ticks (laid-back tempo); same characters,
// same colors, different rhythm. Reduced motion never swings (the dot path
// below is untouched).
const QUICKSILVER_SWING = [0, 0, 1, 2, 2, 3, 4, 5] as const;

type Props = {
  frame: number;
  messageColor: keyof Theme;
  /** the restrained mid-stream "still waiting" ease
   *  (0..STILL_WAITING_MAX_INTENSITY) toward the theme's AMBER attention
   *  role — never CRIMSON (danger is reserved for real terminal failure). */
  attentionIntensity?: number;
  reducedMotion?: boolean;
  time?: number;
  /** 'quicksilver' swings the frame walk (quicksilver thinking lines);
   *  default even. */
  cadence?: 'standard' | 'quicksilver';
};

export function SpinnerGlyph({
  frame,
  messageColor,
  attentionIntensity = 0,
  reducedMotion = false,
  time = 0,
  cadence = 'standard',
}: Props): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // Reduced motion: slowly flashing dot.
  if (reducedMotion) {
    const isDim = Math.floor(time / (REDUCED_MOTION_CYCLE_MS / 2)) % 2 === 1;
    return (
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={messageColor} dimColor={isDim}>
          {REDUCED_MOTION_DOT}
        </Text>
      </Box>
    );
  }

  const frameIndex =
    cadence === 'quicksilver'
      ? Math.floor(frame / QUICKSILVER_SWING.length) * 6 +
        QUICKSILVER_SWING[frame % QUICKSILVER_SWING.length]!
      : frame;
  const spinnerChar = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];

  // Ease gently toward the AMBER attention role on a real mid-stream gap
  // restrained, never the failure red.
  if (attentionIntensity > 0) {
    const baseColorStr = theme[messageColor];
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
    const attentionRGB = parseRGB(theme.warning);
    if (baseRGB && attentionRGB) {
      const interpolated = interpolateColor(baseRGB, attentionRGB, attentionIntensity);
      return (
        <Box flexWrap="wrap" height={1} width={2}>
          <Text color={toRGBColor(interpolated)}>{spinnerChar}</Text>
        </Box>
      );
    }
    // Fallback for ANSI themes (no interpolable channels): flip to the plain
    // warning role once the ease passes its halfway point.
    const color =
      attentionIntensity >= STILL_WAITING_MAX_INTENSITY / 2 ? 'warning' : messageColor;
    return (
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={color}>{spinnerChar}</Text>
      </Box>
    );
  }

  return (
    <Box flexWrap="wrap" height={1} width={2}>
      <Text color={messageColor}>{spinnerChar}</Text>
    </Box>
  );
}
