
import React from 'react'
import { Box } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'
import { THINKING_COLOR, ThinkingLabel } from './thinkingGrammar.js'

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
  const thinking = param.thinking ?? ''
  if (thinking === '' || hideInTranscript) return null

  const expanded = verbose || isTranscriptMode
  if (!expanded) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <ThinkingLabel>
          {' '}
          <CtrlOToExpand />
        </ThinkingLabel>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <ThinkingLabel />
      <Box paddingLeft={2} flexDirection="column">
        <Markdown color={THINKING_COLOR}>{thinking}</Markdown>
      </Box>
    </Box>
  )
}

export default AssistantThinkingMessage
