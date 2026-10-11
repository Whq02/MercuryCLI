import * as React from 'react'
import { Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import type { JournalStageOutcome } from '../../mneme/journal.js'

export function renderJournalToolUse(input?: Record<string, unknown>): string {
  return typeof input?.entry === 'string' ? `${input.entry.trim().length} characters` : ''
}

export function renderJournalResult(output?: JournalStageOutcome): React.ReactNode {
  if (!output) return null
  return (
    <MessageResponse>
      {output.staged ? (
        <Text color="success">{`entry ${output.replaced ? 'replaced' : 'staged'} · written to the journal at session end`}</Text>
      ) : (
        <Text color="warning">{`refused — ${output.reason}`}</Text>
      )}
    </MessageResponse>
  )
}
