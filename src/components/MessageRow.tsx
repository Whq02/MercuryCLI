import React, { memo } from 'react'
import { Box } from '../ink.js'
import type { Screen } from '../screens/Chat.js'
import type {
  NormalizedMessage,
  ProgressMessage,
  RenderableMessage,
} from '../types/message.js'
import type { Tools } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Command } from '../commands.js'
import type { MessageLookups } from '../services/messages/lookups.js'
import {
  getSiblingToolUseIDsFromLookup,
  getProgressMessagesFromLookup,
  getToolUseID,
  hasUnresolvedHooksFromLookup,
} from '../services/messages/lookups.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../state/ephemeralProgressStore.js'
import { MessageActionsSelectedContext } from './messageActions.js'
import { Message } from './Message.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'

const EMPTY_PROGRESS: ProgressMessage[] = []
const EMPTY_IDS = new Set<string>()

function isMessageStreaming(
  msg: RenderableMessage,
  streamingToolUseIDs: Set<string>,
): boolean {
  const id = getToolUseID(msg as NormalizedMessage)
  return id !== undefined && id !== null && streamingToolUseIDs.has(id)
}

function allToolsResolved(
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
      allToolsResolved(member, resolvedToolUseIDs),
    )
  }
  if (msg.type === 'assistant') {
    const content = msg.message.content
    if (!Array.isArray(content)) return true
    return content.every(
      block => block.type !== 'tool_use' || resolvedToolUseIDs.has(block.id),
    )
  }
  return true
}

function rowToolUseIDs(msg: RenderableMessage): string[] {
  if (msg.type === 'grouped_tool_use') {
    const ids: string[] = []
    for (const member of msg.messages) {
      const first = member.message.content[0]
      if (first?.type === 'tool_use') {
        ids.push(first.id)
      }
    }
    return ids
  }
  if (msg.type === 'collapsed_read_search') {
    const ids: string[] = []
    for (const member of msg.messages) {
      ids.push(...rowToolUseIDs(member))
    }
    return ids
  }
  if (msg.type === 'assistant') {
    const content = msg.message.content
    if (!Array.isArray(content)) return []
    const ids: string[] = []
    for (const block of content) {
      if (block.type === 'tool_use') {
        ids.push(block.id)
      }
    }
    return ids
  }
  return []
}

export function toolStateMoved(
  prev: Pick<MessageRowProps, 'message' | 'inProgressToolUseIDs' | 'lookups'>,
  next: Pick<MessageRowProps, 'message' | 'inProgressToolUseIDs' | 'lookups'>,
): boolean {
  for (const id of rowToolUseIDs(next.message)) {
    if (prev.lookups.resolvedToolUseIDs.has(id) !== next.lookups.resolvedToolUseIDs.has(id)) return true
    if (prev.inProgressToolUseIDs.has(id) !== next.inProgressToolUseIDs.has(id)) return true
    if (prev.lookups.toolResultByToolUseID.get(id) !== next.lookups.toolResultByToolUseID.get(id)) return true
  }
  return false
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

type MessageRowProps = {
  message: RenderableMessage
  tools: Tools
  commands?: Command[]
  lookups: MessageLookups
  conversationId?: string
  screen: Screen
  columns: number
  style?: 'condensed'
  verbose: boolean
  isUserContinuation: boolean
  hasContentAfter: boolean
  inProgressToolUseIDs: Set<string>
  streamingToolUseIDs: Set<string>
  canAnimate: boolean
  isLoading: boolean
  lastThinkingBlockId: string | null
  latestBashOutputUUID: string | null
  isCursorRow?: boolean
  cursorExpanded?: boolean
  clickExpanded?: boolean
}

function MessageRowInner({
  message,
  tools,
  commands,
  lookups,
  screen,
  columns,
  style,
  verbose,
  isUserContinuation,
  hasContentAfter,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  canAnimate,
  isLoading,
  lastThinkingBlockId,
  latestBashOutputUUID,
  isCursorRow = false,
  cursorExpanded = false,
  clickExpanded = false,
}: MessageRowProps): React.ReactNode {
  const isGroupish =
    message.type === 'grouped_tool_use' ||
    message.type === 'collapsed_read_search'
  const singleToolId =
    isGroupish || message.type === 'turn_receipt'
      ? null
      : getToolUseID(message)

  useEphemeralProgressVersion(singleToolId !== null ? [singleToolId] : [])

  let progressMessagesForMessage: ProgressMessage[] = EMPTY_PROGRESS
  if (!isGroupish && message.type !== 'turn_receipt' && singleToolId !== null) {
    const recorded = getProgressMessagesFromLookup(message, lookups)
    const ephemeral = getEphemeralProgressFrame(singleToolId)
    progressMessagesForMessage =
      ephemeral !== undefined ? [...recorded, ephemeral] : recorded
  }

  const rowVerbose =
    verbose || clickExpanded || (isCursorRow && cursorExpanded)
  const addMargin = !isUserContinuation
  const shouldShowDot = screen === 'prompt'
  const isTranscriptMode = screen === 'transcript'

  let shouldAnimate = false
  if (canAnimate) {
    if (message.type === 'grouped_tool_use') {
      shouldAnimate = message.messages.some(member => {
        const first = member.message.content[0]
        return first?.type === 'tool_use' && inProgressToolUseIDs.has(first.id)
      })
    } else if (message.type === 'collapsed_read_search') {
      shouldAnimate = message.messages.some(member => {
        if (member.type === 'grouped_tool_use') {
          return member.messages.some(nested => {
            const first = nested.message.content[0]
            return (
              first?.type === 'tool_use' && inProgressToolUseIDs.has(first.id)
            )
          })
        }
        const id = getToolUseID(member)
        return id !== null && inProgressToolUseIDs.has(id)
      })
    } else {
      shouldAnimate =
        singleToolId === null || inProgressToolUseIDs.has(singleToolId)
    }
  }

  const isActiveGroup =
    message.type === 'collapsed_read_search' &&
    (shouldAnimate || (isLoading && !hasContentAfter))

  const isLatestShellOutput =
    latestBashOutputUUID !== null && message.uuid === latestBashOutputUUID

  const siblingToolUseIDs =
    message.type === 'grouped_tool_use'
      ? getSiblingToolUseIDsFromLookup(message.displayMessage, lookups)
      : message.type === 'collapsed_read_search' ||
          message.type === 'turn_receipt'
        ? EMPTY_IDS
        : getSiblingToolUseIDsFromLookup(message, lookups)

  const isStatic = shouldRenderStatically(
    message,
    streamingToolUseIDs,
    inProgressToolUseIDs,
    siblingToolUseIDs,
    screen,
    lookups,
  )

  const body = (
    <Message
      message={message}
      tools={tools}
      commands={commands}
      verbose={rowVerbose}
      addMargin={addMargin}
      shouldAnimate={shouldAnimate}
      shouldShowDot={shouldShowDot}
      inProgressToolUseIDs={inProgressToolUseIDs}
      streamingToolUseIDs={streamingToolUseIDs}
      progressMessagesForMessage={progressMessagesForMessage}
      style={style}
      width={columns}
      isTranscriptMode={isTranscriptMode}
      isStatic={isStatic}
      isLatestShellOutput={isLatestShellOutput}
      lastThinkingBlockId={lastThinkingBlockId}
      hasContentAfter={hasContentAfter}
      isActiveGroup={isActiveGroup}
      lookups={lookups}
    />
  )

  const framed =
    isGroupish || singleToolId !== null ? (
      <Box
        flexDirection="column"
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

function shouldRenderStatically(
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
      for (const sibling of siblingToolUseIDs) {
        if (!lookups.resolvedToolUseIDs.has(sibling)) return false
      }
      return allToolsResolved(message, lookups.resolvedToolUseIDs)
    case 'collapsed_read_search':
      return false
    case 'attachment':
      return true
    case 'assistant': {
      if (message.isVirtual === true) return false
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
      if (hasUnresolvedHooksFromLookup(id, 'tool.after', lookups)) return false
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
      if (hasUnresolvedHooksFromLookup(id, 'tool.after', lookups)) return false
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
  if (prev.isUserContinuation !== next.isUserContinuation) return false
  if (prev.canAnimate !== next.canAnimate) return false
  if (prev.style !== next.style) return false
  if (prev.tools !== next.tools) return false
  if (prev.screen !== next.screen) return false
  if (prev.verbose !== next.verbose) return false
  if (prev.columns !== next.columns) return false
  const prevLatestShell =
    prev.latestBashOutputUUID !== null &&
    prev.message.uuid === prev.latestBashOutputUUID
  const nextLatestShell =
    next.latestBashOutputUUID !== null &&
    next.message.uuid === next.latestBashOutputUUID
  if (prevLatestShell !== nextLatestShell) return false
  if (prev.hasContentAfter !== next.hasContentAfter) return false
  if (prev.lastThinkingBlockId !== next.lastThinkingBlockId) {
    if (
      next.message.type === 'assistant' &&
      Array.isArray(next.message.message.content) &&
      next.message.message.content.some(
        block => block.type === 'thinking' || block.type === 'redacted_thinking',
      )
    ) {
      return false
    }
  }
  if (isMessageStreaming(next.message, next.streamingToolUseIDs)) return false
  if (!allToolsResolved(next.message, next.lookups.resolvedToolUseIDs)) {
    return false
  }
  if (toolStateMoved(prev, next)) return false
  if (Boolean(prev.isCursorRow) !== Boolean(next.isCursorRow)) return false
  if (Boolean(prev.cursorExpanded) !== Boolean(next.cursorExpanded)) return false
  if (Boolean(prev.clickExpanded) !== Boolean(next.clickExpanded)) return false
  if (
    next.message.type === 'collapsed_read_search' &&
    prev.isLoading !== next.isLoading
  ) {
    return false
  }
  return true
}

export const MessageRow = memo(MessageRowInner, areMessageRowPropsEqual)

export default MessageRow
