
import React from 'react'
import { Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { extractTag } from '../../utils/messages.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { NameplateClock } from './TranscriptNameplate.js'

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
  const { accent } = useSessionAccent()
  const summary = extractTag(param.text, 'summary')
  if (!summary) return null
  const status = extractTag(param.text, 'status')
  const result = extractTag(param.text, 'result')
  const partial = result !== null && result !== '' && (status === 'failed' || status === 'killed') ? result : null
  return (
    <Box marginTop={addMargin ? 1 : 0} flexDirection="column">
      <Text>
        <NameplateClock />
        <Text color={statusColor(status, accent)}>● </Text>
        <Text dimColor>{summary}</Text>
      </Text>
      {partial !== null ? (
        <Text dimColor>
          {'  '}partial result kept ({partial.length} chars) — send it a message to resume
        </Text>
      ) : null}
    </Box>
  )
}

export default UserAgentNotificationMessage
