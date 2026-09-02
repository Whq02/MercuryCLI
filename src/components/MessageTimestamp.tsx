// Transcript-mode timestamp stamp: local 24-hour HH:MM, zero-padded — every
// clock the product prints reads the same way, never a locale-formatted
// 12-hour value. Reserves exactly its display width.

import React from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { NormalizedMessage } from '../types/message.js'

export function MessageTimestamp({
  message,
  isTranscriptMode,
}: {
  message: NormalizedMessage
  isTranscriptMode: boolean
}): React.ReactNode {
  if (!isTranscriptMode) return null
  const raw = (message as { timestamp?: string }).timestamp
  if (!raw) return null
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return null
  const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(
    at.getMinutes(),
  ).padStart(2, '0')}`
  return (
    <Box minWidth={stringWidth(stamp)}>
      <Text dimColor>{stamp}</Text>
    </Box>
  )
}

export default MessageTimestamp
