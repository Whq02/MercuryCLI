import React from 'react'
import { Box, Text } from '../../ink.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { TEARDROP_ASTERISK } from '../../constants/figures.js'

type Props = {
  addMargin: boolean
}

// the redacted-thinking transcript stub. On Mercury its lede follows
// the LIVE session-critter accent — matching its sibling AssistantThinkingMessage
// (∴ Thinking) — so the identity hue stays consistent across renderers and
// re-tints under /critter; bare-stamp it keeps the default dim-grey
// italic. A plain component (no React-Compiler `_c` memo cache); the ✻ glyph
// comes from the TEARDROP_ASTERISK constant instead of a raw literal.
export function AssistantRedactedThinkingMessage({
  addMargin = false,
}: Props): React.ReactNode {
  // Subscribed so a mounted stub re-tints with /critter · /accent live.
  const accent = useSessionAccent().accent
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text color={accent} dimColor={false} italic>
        {TEARDROP_ASTERISK} Thinking…
      </Text>
    </Box>
  )
}
