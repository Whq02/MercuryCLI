// Transcript-mode model-name stamp. The internal synthetic sentinel marks
// API-error rows, interrupts and resume recaps — it is not a model name and
// is never stamped. The stamp reserves the name's display width plus 8
// columns so neighbouring rows align.

import React from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { NormalizedMessage } from '../types/message.js'
import { SYNTHETIC_MODEL } from '../utils/messages/factories.js'

export function MessageModel({
  message,
  isTranscriptMode,
}: {
  message: NormalizedMessage
  isTranscriptMode: boolean
}): React.ReactNode {
  if (!isTranscriptMode) return null
  if (message.type !== 'assistant') return null
  const model = message.message.model
  if (!model || model === SYNTHETIC_MODEL) return null
  return (
    <Box minWidth={stringWidth(model) + 8}>
      <Text dimColor>{model}</Text>
    </Box>
  )
}

export default MessageModel
