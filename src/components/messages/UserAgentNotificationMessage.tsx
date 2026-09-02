// One-line subagent completion notice with a status-coloured dot. Statuses
// (contract data, from the status element): completed → success, failed →
// error, killed → warning; anything else — in-progress included — wears the
// LIVE session accent, subscribed so /critter and /accent repaint mounted
// rows in the same commit.

import React from 'react'
import { Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { extractTag } from '../../utils/messages.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'

function statusColor(status: string | null, accent: string): string {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return accent
  }
}

export function UserAgentNotificationMessage({
  addMargin,
  param,
}: {
  addMargin?: boolean
  param: TextBlockParam
}): React.ReactNode {
  // Subscribed, never a one-shot read (the accent-subscription prover pins
  // this).
  const { accent } = useSessionAccent()
  const summary = extractTag(param.text, 'summary')
  if (!summary) return null
  const status = extractTag(param.text, 'status')
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color={statusColor(status, accent)}>● </Text>
        <Text dimColor>{summary}</Text>
      </Text>
    </Box>
  )
}

export default UserAgentNotificationMessage
