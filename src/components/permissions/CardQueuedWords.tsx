import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import * as pendingInput from '../../input-core/pending-input.js'

export const CARD_QUEUED_WORDS_HINT = 'waits in the composer until the turn ends · ⌫ edits'

export function CardQueuedWords(): React.ReactNode {
  useSyncExternalStore(pendingInput.subscribePendingInput, pendingInput.editGeneration, pendingInput.editGeneration)
  const words = pendingInput.text()
  if (words.trim() === '') return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>{'❯ '}</Text>
        <Text wrap="truncate-end">{words}</Text>
      </Box>
      <Text dimColor>{`  ${CARD_QUEUED_WORDS_HINT}`}</Text>
    </Box>
  )
}
