// Collapsed/expanded thinking block. The session accent is SUBSCRIBED, not
// read once — a mounted thinking row must repaint in the same commit when
// the accent changes — and the subscription runs before the early returns.
// This component receives no effort/elapsed/token data and invents none.

import React from 'react'
import { Box, Text } from '../../ink.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'

// U+2733 carries the Unicode Emoji property: Windows Terminal renders the
// bare codepoint as a COLOUR EMOJI (operator screenshot). VS15 (U+FE0E)
// forces text presentation; it is zero-width under stringWidth.
const THINKING_GLYPH = '✳\uFE0E'

export function AssistantThinkingMessage({
  param,
  addMargin = false,
  verbose = false,
  isTranscriptMode = false,
  hideInTranscript = false,
}: {
  param: { type?: string; thinking?: string }
  addMargin?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
  hideInTranscript?: boolean
}): React.ReactNode {
  // Subscription above the early returns (hook-order rule; the accent
  // prover pins the subscription).
  const accent = useSessionAccent().accent
  const thinking = param.thinking ?? ''
  if (thinking === '' || hideInTranscript) return null

  const expanded = verbose || isTranscriptMode
  if (!expanded) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text italic color={accent}>
          {THINKING_GLYPH} Thinking… <CtrlOToExpand />
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text italic color={accent}>
        {THINKING_GLYPH} Thinking…
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <Markdown color="subtle">{thinking}</Markdown>
      </Box>
    </Box>
  )
}

export default AssistantThinkingMessage
