import * as React from 'react'
import { Box, Text } from '../ink.js'
import { FAINT, SAND, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js'
import { getAllReleaseNotes } from '../utils/releaseNotes.js'

/** The "what's new" card: one line per bundled changelog version (newest first). */
export function MercuryReleaseNotes() {
  const rows = getAllReleaseNotes().reverse().map(([version, notes]) => [version, notes[0] ?? ''] as const)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
      <Text bold color={TERRA}>{CRAB} what's new</Text>
      {rows.map(([v, t]) => (
        <Text key={v}>
          <Text color={TERRA}>{padTo(v, 13)}</Text>
          <Text color={SAND}>{t}</Text>
        </Text>
      ))}
      <Text color={FAINT}>esc close</Text>
    </Box>
  )
}
