
import React from 'react'
import { Box, Text } from '../../ink.js'
import { isShutdownRejected, isShutdownRequest, type ShutdownRejectedMessage, type ShutdownRequestMessage } from '../../services/crew/liveMessages.js'

function ShutdownRequestDisplay({
  request,
}: {
  request: ShutdownRequestMessage
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="warning">
        @{request.from} requested shutdown
        {request.reason ? <Text dimColor> — {request.reason}</Text> : null}
      </Text>
    </Box>
  )
}

function ShutdownRejectedDisplay({
  rejected,
}: {
  rejected: ShutdownRejectedMessage
}): React.ReactNode {
  const reason = (rejected as { reason?: string }).reason
  return (
    <Box flexDirection="column">
      <Text color="subtle">
        @{rejected.from} declined the shutdown
        {reason ? ` — ${reason}` : ''}. The crewmate continues and may be
        asked again.
      </Text>
    </Box>
  )
}

export function tryRenderShutdownMessage(
  content: string,
): React.ReactNode | null {
  const request = isShutdownRequest(content)
  if (request) return <ShutdownRequestDisplay request={request} />
  const rejected = isShutdownRejected(content)
  if (rejected) return <ShutdownRejectedDisplay rejected={rejected} />
  return null
}
