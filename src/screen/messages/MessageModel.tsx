
import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { stringWidth } from '../renderer/stringWidth.js'
import type { NormalizedMessage } from '../../engine/message-shapes/message.js'
import { SYNTHETIC_MODEL } from '../../engine/message-shapes/factories.js'

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
