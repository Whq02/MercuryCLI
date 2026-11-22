import React, { memo } from 'react'
import { Box } from '../ink.js'
import type { ToolResultBlockParam } from '../types/wire.js'
import type {
  AssistantMessage,
  NormalizedMessage,
  ProgressMessage,
  RenderableMessage,
} from '../types/message.js'
import type { Tools } from '../Tool.js'
import type { Command } from '../commands.js'
import type { MessageLookups } from '../services/messages/lookups.js'
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage.js'
import { AssistantTextMessage } from './messages/AssistantTextMessage.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js'
import { AttachmentMessage } from './messages/AttachmentMessage.js'
import { CollapsedReadSearchContent } from './messages/CollapsedReadSearchContent.js'
import { CompactBoundaryMessage } from './messages/CompactBoundaryMessage.js'
import { CrewChatRow } from './messages/CrewChatRow.js'
import { CompactSummary } from './CompactSummary.js'
import { ExpandShellOutputProvider } from './shell/ExpandShellOutputContext.js'
import { GroupedToolUseContent } from './messages/GroupedToolUseContent.js'
import { MessageMetaProvider, ReplyAddress, replyAddressLine } from './messages/TranscriptNameplate.js'
import { SystemTextMessage } from './messages/SystemTextMessage.js'
import { TurnReceiptRow } from './messages/TurnReceiptRow.js'
import { UserImageMessage } from './messages/UserImageMessage.js'
import { UserTextMessage } from './messages/UserTextMessage.js'
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage.js'
import { MessageModel } from './MessageModel.js'
import { MessageTimestamp } from './MessageTimestamp.js'
import { SYNTHETIC_MODEL } from '../utils/messages/factories.js'
import { parseReferences } from '../history.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type Props = Unbuilt

function hasThinkingContent(m: RenderableMessage | AssistantMessage): boolean {
  if (m.type !== 'assistant') return false
  const content = m.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

function displayMessageOf(message: RenderableMessage | AssistantMessage): NormalizedMessage | AssistantMessage | null {
  if (message.type === 'grouped_tool_use') {
    return (message as { displayMessage?: NormalizedMessage }).displayMessage ?? null
  }
  if (message.type === 'collapsed_read_search') {
    return (message as { displayMessage?: NormalizedMessage }).displayMessage ?? null
  }
  return message as NormalizedMessage | AssistantMessage
}

function MessageInner(arg0: Props): React.ReactNode {
  return notBuilt('src/components/Message.tsx:79')
}

function areMessagePropsEqual(prev: Props, next: Props): boolean {
  return notBuilt('src/components/Message.tsx:376')
}

export const Message = memo(MessageInner, areMessagePropsEqual)

export default Message
