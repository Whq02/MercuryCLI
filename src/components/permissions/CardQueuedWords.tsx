import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { consentDeclineRow, queuedWordsHint, subscribeConsentRows } from '../../utils/cockpit/composerSeed.js'

export function CardQueuedWords(): React.ReactNode {
  useSyncExternalStore(pendingInput.subscribePendingInput, pendingInput.editGeneration, pendingInput.editGeneration)
  const declineRow = useSyncExternalStore(subscribeConsentRows, consentDeclineRow, consentDeclineRow)
  const words = pendingInput.text()
  if (words.trim() === '') return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>{'❯ '}</Text>
        <Text wrap="truncate-end">{words}</Text>
      </Box>
      <Text dimColor>{`  ${queuedWordsHint(declineRow)}`}</Text>
    </Box>
  )
}
