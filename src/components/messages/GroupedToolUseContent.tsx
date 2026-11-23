import React from 'react'
import { Box } from '../../ink.js'
import type {
  GroupedToolUseMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
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
  const memberIds: string[] = []
  for (const member of message.messages) {
    const first = member.message.content[0]
    if (first && first.type === 'tool_use') {
      memberIds.push(first.id)
    }
  }
  useEphemeralProgressVersion(memberIds)

  const tool = findToolByName(tools, message.toolName)
  if (!tool?.renderGroupedToolUse) {
    return null
  }

  const items = message.messages.flatMap(member => {
    const toolUse = member.message.content[0]
    if (!toolUse || toolUse.type !== 'tool_use') return []
    const id = toolUse.id
    const recorded = lookups.progressMessagesByToolUseID.get(id) ?? []
    const ephemeral = getEphemeralProgressFrame(id)
    const progressMessages: ProgressMessage[] =
      ephemeral !== undefined ? [...recorded, ephemeral] : recorded
    const resultHolder = lookups.toolResultByToolUseID.get(id)
    const resultMessage = resultHolder?.type === 'user' ? resultHolder : undefined
    const rawResult = resultMessage?.toolUseResult
    return [
      {
        toolUse,
        isResolved: lookups.resolvedToolUseIDs.has(id),
        isErrored: lookups.erroredToolUseIDs.has(id),
        isDenied: lookups.deniedToolUseIDs.has(id),
        isInProgress: inProgressToolUseIDs.has(id),
        progressMessages,
        resultMessage,
        rawResult,
      },
    ]
  })

  const content = tool.renderGroupedToolUse(items, {
    tools,
    shouldAnimate,
    message,
  })
  if (content === null || content === undefined) {
    return null
  }

  return (
    <Box>
      <Box flexShrink={0}>
        <TranscriptNameplate />
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {content}
      </Box>
    </Box>
  )
}

export default GroupedToolUseContent
