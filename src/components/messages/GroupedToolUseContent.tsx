// A batch of same-named tool calls delegated to that tool's own group
// renderer. The ephemeral-progress subscription covers exactly this group's
// member ids and runs unconditionally, above any early return.

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
  // Subscribes to ephemeral ticks for exactly its own members' ids —
  // unconditionally, above any early return.
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

  // The group renderer returns BLOCK content (a Box) — it must never sit
  // inside a text node (a box nested in a text component throws in the
  // reconciler; first hit: two parallel Agent spawns in one turn).
  return (
    <Box flexDirection="row">
      {/* Non-shrinking: a bare Text row child yields width to the group body
          and clips the name; the nameplate keeps its measured width. */}
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
