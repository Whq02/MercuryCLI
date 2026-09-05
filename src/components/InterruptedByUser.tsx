import * as React from 'react';
import { Text } from '../ink.js';
import { CRIMSON } from './mercuryPalette.js';
import { GLYPH } from './mercury-ui/glyphs.js';

export function InterruptedByUser({ why }: { why?: string | null } = {}) {
  return (
    <>
      <Text color={CRIMSON}>{GLYPH.conflict} </Text>
      <Text dimColor>{why ? 'Cut off ' : 'Interrupted '}</Text>
      <Text dimColor>{why ? `· ${why}` : '· What should Mercury do instead?'}</Text>
    </>
  );
}
