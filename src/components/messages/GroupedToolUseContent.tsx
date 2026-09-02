
import React from 'react'
import { Box } from '../../ink.js'
import type {
  GroupedToolUseMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { MessageLookups } from '../../utils/messages/lookups.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../../state/ephemeralProgressStore.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'

export function GroupedToolUseContent({
  message,
  tools,
  lookups,
  inProgressToolUseIDs,
  shouldAnimate = false,
}: {
  message: GroupedToolUseMessage
  tools: Tools
  lookups: MessageLookups
  inProgressToolUseIDs: Set<string>
  shouldAnimate?: boolean
}): React.ReactNode {
  const memberIds = React.useMemo(
    () =>
      message.messages
        .map(member => {
          const first = member.message.content[0]
          return first && first.type === 'tool_use' ? first.id : undefined
        })
        .filter((id): id is string => id !== undefined),
    [message.messages],
  )
  useEphemeralProgressVersion(memberIds)

  const tool = findToolByName(tools, message.toolName)
  if (!tool || !tool.renderGroupedToolUse) return null

  const members = message.messages.map(member => {
    const first = member.message.content[0]
    const toolUse = first && first.type === 'tool_use' ? first : undefined
    const id = toolUse?.id ?? ''
    const recorded = lookups.progressMessagesByToolUseID.get(id) ?? []
    const ephemeral = getEphemeralProgressFrame(id)
    const progressMessages: ProgressMessage[] = ephemeral
      ? [...recorded, ephemeral]
      : recorded
    const resultMessage = lookups.toolResultByToolUseID.get(id)
    return {
      toolUse,
      isResolved: lookups.resolvedToolUseIDs.has(id),
      isErrored: lookups.erroredToolUseIDs.has(id),
      isInProgress: inProgressToolUseIDs.has(id),
      progressMessages,
      resultMessage,
      rawResult:
        resultMessage && 'toolUseResult' in resultMessage
          ? resultMessage.toolUseResult
          : undefined,
    }
  })

  const anyInProgress = members.some(member => member.isInProgress)

  return (
    <Box flexDirection="row">
      {
}
      <Box flexShrink={0}>
        <TranscriptNameplate />
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {tool.renderGroupedToolUse(members, {
          tools,
          shouldAnimate: shouldAnimate && anyInProgress,
        })}
      </Box>
    </Box>
  )
}

export default GroupedToolUseContent
