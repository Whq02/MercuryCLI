
import React from 'react'
import { Box, Text } from '../../ink.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'

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
