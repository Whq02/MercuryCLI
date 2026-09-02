
import React, { useContext } from 'react'
import { Box } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { logError } from '../../utils/log.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { MessageActionsSelectedContext } from '../messageActions.js'
import { HighlightedThinkingText } from './HighlightedThinkingText.js'

const TRUNCATE_THRESHOLD = 10_000
const HEAD_CHARS = 2_500
const TAIL_CHARS = 2_500

function headTailTruncated(text: string): string {
  if (text.length <= TRUNCATE_THRESHOLD) return text
  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(text.length - TAIL_CHARS)
  const hidden = text.slice(HEAD_CHARS, text.length - TAIL_CHARS)
  const hiddenLines = (hidden.match(/\n/g) ?? []).length
  return `${head}\n… +${hiddenLines} lines …\n${tail}`
}

export function UserPromptMessage({
  addMargin,
  param,
  isTranscriptMode,
  timestamp,
}: {
  addMargin: boolean
  param: TextBlockParam
  isTranscriptMode?: boolean
  timestamp?: string
}): React.ReactNode {
  const sanitized = headTailTruncated(stripTerminalControls(param.text))
  const isSelected = useContext(MessageActionsSelectedContext)
  void isTranscriptMode
  if (sanitized === '') {
    logError(new Error('UserPromptMessage rendered with empty text'))
    return null
  }
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
    >
      <HighlightedThinkingText text={sanitized} timestamp={timestamp} />
    </Box>
  )
}

export default UserPromptMessage
