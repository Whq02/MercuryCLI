// ExitPlanMode rows: approved / empty / awaiting-lead /
// rejected.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../../components/Markdown.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { RejectedPlanMessage } from '../../components/messages/UserToolResultMessage/RejectedPlanMessage.js'
import { getDisplayPath } from '../../utils/file.js'
import { getPlan } from '../../utils/plans.js'
import type { Input, Output } from './ExitPlanModeV2Tool.js'

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (!output) return null

  if (output.awaitingLeaderApproval) {
    return (
      <MessageResponse>
        <Box flexDirection="column">
        <Text>
          <Text color="cyan">•</Text> Plan submitted for lead approval
        </Text>
        <Box marginLeft={2} flexDirection="column">
          {output.filePath ? (
            <Text dimColor>{getDisplayPath(output.filePath)}</Text>
          ) : null}
          <Text dimColor>Waiting for the lead's review…</Text>
          </Box>
        </Box>
      </MessageResponse>
    )
  }

  if (!output.plan || output.plan.trim() === '') {
    return (
      <MessageResponse height={1}>
        <Text>
          <Text color="cyan">•</Text> Exited strategy mode
        </Text>
      </MessageResponse>
    )
  }

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">•</Text> Mercury's plan approved
        </Text>
        <Box marginLeft={2} flexDirection="column">
          {output.filePath ? (
            <Text dimColor>
              {getDisplayPath(output.filePath)} · /plan edits it
            </Text>
          ) : null}
          <Markdown>{output.plan}</Markdown>
        </Box>
      </Box>
    </MessageResponse>
  )
}

export function renderToolUseRejectedMessage(
  input?: Partial<Input>,
): React.ReactNode {
  const plan = input?.plan ?? getPlan() ?? 'No plan found'
  return <RejectedPlanMessage plan={plan} />
}

export function renderToolUseMessage(): React.ReactNode {
  return null
}
