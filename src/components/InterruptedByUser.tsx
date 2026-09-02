import * as React from 'react';
import { Text } from '../ink.js';
import { CRIMSON } from './mercuryPalette.js';
import { GLYPH } from './mercury-ui/glyphs.js';

/**
 * The universal "turn/tool stopped by the operator" row (canceled tool
 * results + fallback rejections + mid-turn esc). Fork: lead with the kit's
 * conflict glyph in CRIMSON so an interruption reads at a glance in scrollback
 * (the status spine, not the accent — interrupt is a stop state); copy stays
 * the quiet dim ask. base renders the plain dim pair unchanged.
 */
export function InterruptedByUser() {
  return (
    <>
      <Text color={CRIMSON}>{GLYPH.conflict} </Text>
      <Text dimColor>Interrupted </Text>
      <Text dimColor>· What should Mercury do instead?</Text>
    </>
  );
}
