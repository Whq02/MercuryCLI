// The user turn. Sanitising is a security requirement, not cosmetics:
// resumed history and piped stdin bypass the composer's input filter, and a
// persisted clear-screen sequence painted verbatim would be obeyed by the
// terminal mid-frame. Above 10 000 displayed characters the text is
// head+tail truncated — the tail matters because a piped file followed by an
// echoed question puts the real question last, and a single huge text node
// re-wraps on every fullscreen frame (500 ms+ keystroke latency).

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
  /** Accepted and currently unused — the brief-mode layout it fed is forked
   *  off; kept in the signature deliberately. */
  isTranscriptMode?: boolean
  timestamp?: string
}): React.ReactNode {
  // Sanitising and truncation run before any early return so hook order is
  // stable across renders.
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
