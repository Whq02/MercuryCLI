
import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { extractTag } from '../../utils/messages.js'

const ACKNOWLEDGEMENTS = [
  'Noted.',
  'Got it — remembering that.',
  'Saved to memory.',
  'Understood.',
]

export function UserMemoryInputMessage({
  addMargin,
  text,
}: {
  addMargin: boolean
  text: string
}): React.ReactNode {
  const [acknowledgement] = useState(
    () =>
      ACKNOWLEDGEMENTS[Math.floor(Math.random() * ACKNOWLEDGEMENTS.length)] ??
      'Noted.',
  )
  const note = extractTag(text, 'user-memory-input')
  if (!note) return null
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text backgroundColor="memoryBackgroundColor">
        <Text color="remember"># </Text>
        {note}
      </Text>
      <Text dimColor>{acknowledgement}</Text>
    </Box>
  )
}

export default UserMemoryInputMessage
