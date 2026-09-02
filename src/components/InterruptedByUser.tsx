import * as React from 'react';
import { Text } from '../ink.js';
import { CRIMSON } from './mercuryPalette.js';
import { GLYPH } from './mercury-ui/glyphs.js';

export function InterruptedByUser() {
  return (
    <>
      <Text color={CRIMSON}>{GLYPH.conflict} </Text>
      <Text dimColor>Interrupted </Text>
      <Text dimColor>· What should Mercury do instead?</Text>
    </>
  );
}
