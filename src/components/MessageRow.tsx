
import React, { memo, useContext } from 'react'
import { Box } from '../ink.js'
import type { Screen } from '../screens/REPL.js'
import type {
  NormalizedMessage,
  ProgressMessage,
  RenderableMessage,
} from '../types/message.js'
import type { Tools } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Command } from '../commands.js'
import type { MessageLookups } from '../utils/messages/lookups.js'
import {
  getSiblingToolUseIDsFromLookup,
  getProgressMessagesFromLookup,
  getToolUseID,
  hasUnresolvedHooksFromLookup,
} from '../utils/messages/lookups.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../state/ephemeralProgressStore.js'
import { MessageActionsSelectedContext } from './messageActions.js'
import { Message } from './Message.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'

const EMPTY_PROGRESS: ProgressMessage[] = []
const EMPTY_IDS = new Set<string>()

export function isMessageStreaming(
  msg: RenderableMessage,
  streamingToolUseIDs: Set<string>,
): boolean {
  const id = getToolUseID(msg as NormalizedMessage)
  return id !== undefined && id !== null && streamingToolUseIDs.has(id)
}

export function allToolsResolved(
  msg: RenderableMessage,
  resolvedToolUseIDs: Set<string>,
): boolean {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.every(member => {
      const first = member.message.content[0]
      return first?.type !== 'tool_use' || resolvedToolUseIDs.has(first.id)
    })
  }
  if (msg.type === 'collapsed_read_search') {
    return msg.messages.every(member =>
      member.type === 'grouped_tool_use'
        ? allToolsResolved(member, resolvedToolUseIDs)
        : allToolsResolved(member as RenderableMessage, resolvedToolUseIDs),
    )
  }
  if (msg.type !== 'assistant') return true
  const content = msg.message.content
  if (!Array.isArray(content)) return true
  return content.every(
    block => block.type !== 'tool_use' || resolvedToolUseIDs.has(block.id),
  )
}

export function hasContentAfterIndex(
  messages: RenderableMessage[],
  index: number,
  tools: Tools,
  streamingToolUseIDs: Set<string>,
): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (message.type === 'system' || message.type === 'attachment') continue
    if (message.type === 'collapsed_read_search') continue
    if (message.type === 'grouped_tool_use') continue
    if (message.type === 'turn_receipt') continue
    if (message.type === 'assistant') {
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : []
      let meaningful = false
      for (const block of content) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          continue
        }
        if (block.type === 'tool_use') {
          const tool = findToolByName(tools, block.name)
          const collapsible =
            tool !== undefined &&
            (tool as { isReadOnly?: (input?: unknown) => boolean }).isReadOnly?.(
              block.input,
            ) === true
          if (collapsible) continue
          if (streamingToolUseIDs.has(block.id)) continue
          meaningful = true
          break
        }
        meaningful = true
        break
      }
      if (meaningful) return true
      continue
    }
    if (message.type === 'user') {
      const content = message.message.content
      if (
        Array.isArray(content) &&
        content.every(block => block.type === 'tool_result')
      ) {
        continue
      }
      return true
    }
    return true
  }
  return false
}

export type MessageRowProps = {
  message: RenderableMessage
  isUserContinuation: boolean
  hasContentAfter: boolean
  tools: Tools
  commands: Command[]
  verbose: boolean
  inProgressToolUseIDs: Set<string>
  streamingToolUseIDs: Set<string>
  screen: Screen
  canAnimate: boolean
  lastThinkingBlockId: string | null
  latestBashOutputUUID: string | null
  columns: number
  isLoading: boolean
  lookups: MessageLookups
  conversationId?: string
  isCursorRow?: boolean
  cursorExpanded?: boolean
  clickExpanded?: boolean
  advisorModel?: string | null
  style?: 'condensed'
}

function MessageRowInner({
  message,
  isUserContinuation,
  hasContentAfter,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  screen,
  canAnimate,
  lastThinkingBlockId,
  latestBashOutputUUID,
  columns,
  isLoading,
  lookups,
  isCursorRow = false,
  cursorExpanded = false,
  clickExpanded = false,
  advisorModel,
  style,
}: MessageRowProps): React.ReactNode {
  const isTranscriptMode = screen === 'transcript'
  const toolUseID =
    message.type === 'grouped_tool_use' ||
    message.type === 'collapsed_read_search' ||
    message.type === 'turn_receipt'
      ? undefined
      : (getToolUseID(message as NormalizedMessage) ?? undefined)

  useEphemeralProgressVersion(toolUseID ? [toolUseID] : [])

  const isGroupish =
    message.type === 'grouped_tool_use' ||
    message.type === 'collapsed_read_search'

  const progressMessagesForMessage = ((): ProgressMessage[] => {
    if (isGroupish || !toolUseID) return EMPTY_PROGRESS
    const recorded = getProgressMessagesFromLookup(
      message as NormalizedMessage,
      lookups,
    )
    const ephemeral = getEphemeralProgressFrame(toolUseID)
    return ephemeral ? [...recorded, ephemeral] : recorded
  })()

  const rowVerbose = verbose || clickExpanded || (isCursorRow && cursorExpanded)

  const shouldAnimate =
    canAnimate &&
    (message.type === 'grouped_tool_use'
      ? message.messages.some(member => {
          const first = member.message.content[0]
          return first?.type === 'tool_use' && inProgressToolUseIDs.has(first.id)
        })
      : message.type === 'collapsed_read_search'
        ? message.messages.some(member =>
            member.type === 'grouped_tool_use'
              ? member.messages.some(inner => {
                  const first = inner.message.content[0]
                  return (
                    first?.type === 'tool_use' &&
                    inProgressToolUseIDs.has(first.id)
                  )
                })
              : (() => {
                  const id = getToolUseID(member as NormalizedMessage)
                  return id != null && inProgressToolUseIDs.has(id)
                })(),
          )
        : !toolUseID || inProgressToolUseIDs.has(toolUseID))

  const isActiveGroup =
    message.type === 'collapsed_read_search' &&
    (shouldAnimate || (isLoading && !hasContentAfter))

  const isLatestShellOutput =
    latestBashOutputUUID !== null && message.uuid === latestBashOutputUUID

  const isStatic = shouldRenderStatically(
    message,
    streamingToolUseIDs,
    inProgressToolUseIDs,
    toolUseID
      ? getSiblingToolUseIDsFromLookup(message as NormalizedMessage, lookups)
      : EMPTY_IDS,
    screen,
    lookups,
  )

  const body = (
    <Message
      message={message}
      tools={tools}
      commands={commands}
      verbose={rowVerbose}
      addMargin={!isUserContinuation}
      shouldAnimate={shouldAnimate}
      shouldShowDot={screen === 'prompt'}
      isTranscriptMode={isTranscriptMode}
      isStatic={isStatic}
      inProgressToolUseIDs={inProgressToolUseIDs}
      streamingToolUseIDs={streamingToolUseIDs}
      progressMessagesForMessage={progressMessagesForMessage}
      lookups={lookups}
      width={columns}
      style={style}
      isLatestShellOutput={isLatestShellOutput}
      lastThinkingBlockId={lastThinkingBlockId}
      hasContentAfter={hasContentAfter}
      isActiveGroup={isActiveGroup}
      advisorModel={advisorModel}
    />
  )

  const railed = isGroupish || toolUseID !== undefined
  const framed = railed ? (
    <Box
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderDimColor
      paddingLeft={1}
    >
      {body}
    </Box>
  ) : (
    body
  )

  return (
    <OffscreenFreeze>
      <MessageActionsSelectedContext.Provider value={isCursorRow}>
        {framed}
      </MessageActionsSelectedContext.Provider>
    </OffscreenFreeze>
  )
}

export function shouldRenderStatically(
  message: RenderableMessage,
  streamingToolUseIDs: Set<string>,
  inProgressToolUseIDs: Set<string>,
  siblingToolUseIDs: ReadonlySet<string>,
  screen: Screen,
  lookups: MessageLookups,
): boolean {
  if (screen === 'transcript') return true
  switch (message.type) {
    case 'turn_receipt':
      return false
    case 'system':
      return message.subtype !== 'api_error'
    case 'grouped_tool_use':
      return allToolsResolved(message, lookups.resolvedToolUseIDs)
    case 'collapsed_read_search':
      return false
    case 'attachment':
      return true
    case 'assistant': {
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : []
      const first = content[0]
      if (first && first.type === 'server_tool_use') {
        return lookups.resolvedToolUseIDs.has(first.id)
      }
      const id = getToolUseID(message)
      if (id == null) return true
      if (streamingToolUseIDs.has(id) || inProgressToolUseIDs.has(id)) {
        return false
      }
      if (hasUnresolvedHooksFromLookup(id, 'PostToolUse', lookups)) return false
      for (const sibling of siblingToolUseIDs) {
        if (!lookups.resolvedToolUseIDs.has(sibling)) return false
      }
      return lookups.resolvedToolUseIDs.has(id)
    }
    case 'user': {
      const id = getToolUseID(message)
      if (id == null) return true
      if (streamingToolUseIDs.has(id) || inProgressToolUseIDs.has(id)) {
        return false
      }
      if (hasUnresolvedHooksFromLookup(id, 'PostToolUse', lookups)) return false
      for (const sibling of siblingToolUseIDs) {
        if (!lookups.resolvedToolUseIDs.has(sibling)) return false
      }
      return true
    }
    default:
      return true
  }
}

export function areMessageRowPropsEqual(
  prev: MessageRowProps,
  next: MessageRowProps,
): boolean {
  if (prev.message !== next.message) return false
  if (prev.screen !== next.screen) return false
  if (prev.verbose !== next.verbose) return false
  if (
    next.message.type === 'collapsed_read_search' &&
    next.screen !== 'transcript'
  ) {
    return false
  }
  if (prev.columns !== next.columns) return false
  const prevLatest =
    prev.latestBashOutputUUID !== null &&
    prev.message.uuid === prev.latestBashOutputUUID
  const nextLatest =
    next.latestBashOutputUUID !== null &&
    next.message.uuid === next.latestBashOutputUUID
  if (prevLatest !== nextLatest) return false
  if (
    prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
    next.message.type === 'assistant' &&
    Array.isArray(next.message.message.content) &&
    next.message.message.content.some(
      block => block.type === 'thinking' || block.type === 'redacted_thinking',
    )
  ) {
    return false
  }
  if (isMessageStreaming(next.message, next.streamingToolUseIDs)) return false
  if (!allToolsResolved(next.message, next.lookups.resolvedToolUseIDs)) {
    return false
  }
  if (prev.isCursorRow !== next.isCursorRow) return false
  if (prev.cursorExpanded !== next.cursorExpanded) return false
  if (prev.clickExpanded !== next.clickExpanded) return false
  if (prev.isLoading !== next.isLoading && next.message.type === 'collapsed_read_search') return false
  if (prev.hasContentAfter !== next.hasContentAfter) return false
  return true
}

export const MessageRow = memo(MessageRowInner, areMessageRowPropsEqual)

export default MessageRow
