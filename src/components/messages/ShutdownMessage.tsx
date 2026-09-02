// Teammate shutdown request/rejected cards and their summary strings.
// Shutdown-APPROVED deliberately renders nothing here (the caller handles
// it inline) but keeps a summary so inbox surfaces can describe it.

import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  isShutdownApproved,
  isShutdownRejected,
  isShutdownRequest,
  type ShutdownRejectedMessage,
  type ShutdownRequestMessage,
} from '../../utils/teammateMailbox.js'

export function ShutdownRequestDisplay({
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

export function ShutdownRejectedDisplay({
  rejected,
}: {
  rejected: ShutdownRejectedMessage
}): React.ReactNode {
  const reason = (rejected as { reason?: string }).reason
  return (
    <Box flexDirection="column">
      <Text color="subtle">
        @{rejected.from} declined the shutdown
        {reason ? ` — ${reason}` : ''}. The teammate continues and may be
        asked again.
      </Text>
    </Box>
  )
}

/** A shutdown card for a raw payload, or null. Approved payloads return
 *  null by design. */
export function tryRenderShutdownMessage(
  content: string,
): React.ReactNode | null {
  const request = isShutdownRequest(content)
  if (request) return <ShutdownRequestDisplay request={request} />
  const rejected = isShutdownRejected(content)
  if (rejected) return <ShutdownRejectedDisplay rejected={rejected} />
  return null
}

/** Bracketed-label summaries for queue/inbox surfaces. */
export function getShutdownMessageSummary(content: string): string | null {
  const request = isShutdownRequest(content)
  if (request) {
    return `[shutdown] requested by @${request.from}${request.reason ? ` — ${request.reason}` : ''}`
  }
  const rejected = isShutdownRejected(content)
  if (rejected) return `[shutdown] declined by @${rejected.from}`
  const approved = isShutdownApproved(content)
  if (approved) return `[shutdown] @${approved.from} is exiting`
  return null
}
