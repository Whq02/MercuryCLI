import React from 'react'
import { Box } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { logError } from '../../utils/log.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { HighlightedThinkingText } from './HighlightedThinkingText.js'

const MAX_PROMPT_LENGTH = 10_000
const KEEP_EDGE_LENGTH = 2_500

function truncateLongPrompt(text: string): string {
  if (text.length <= MAX_PROMPT_LENGTH) return text
  const head = text.slice(0, KEEP_EDGE_LENGTH)
  const middle = text.slice(KEEP_EDGE_LENGTH, text.length - KEEP_EDGE_LENGTH)
  const tail = text.slice(text.length - KEEP_EDGE_LENGTH)
  let hiddenLines = 0
  for (let i = 0; i < middle.length; i++) {
    if (middle.charCodeAt(i) === 10) hiddenLines += 1
  }
  return `${head}\n… +${hiddenLines} lines …\n${tail}`
}

export function UserPromptMessage({
  addMargin,
  param,
}: {
  addMargin: boolean
  param: TextBlockParam
  isTranscriptMode?: boolean
  timestamp?: string
}): React.ReactNode {
  const selectedBg = useSelectedMessageBg()
  const text = truncateLongPrompt(stripTerminalControls(param.text))
  if (text === '') {
    logError(new Error('UserPromptMessage rendered with empty text'))
    return null
  }
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={selectedBg}
    >
      <HighlightedThinkingText text={text} />
    </Box>
  )
}

export default UserPromptMessage
