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
import { notBuilt, type Unbuilt } from '../pi/holes.js'

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
  return notBuilt('src/components/MessageRow.tsx:39')
}

function rowToolUseIDs(msg: RenderableMessage): string[] {
  return notBuilt('src/components/MessageRow.tsx:64')
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

type MessageRowProps = Unbuilt

function MessageRowInner(arg0: MessageRowProps): React.ReactNode {
  return notBuilt('src/components/MessageRow.tsx:169')
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
  return notBuilt('src/components/MessageRow.tsx:367')
}

export const MessageRow = memo(MessageRowInner, areMessageRowPropsEqual)

export default MessageRow
