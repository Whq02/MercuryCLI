
import type { ContentBlock, RedactedThinkingBlock, ThinkingBlock, ContentBlockParam, RedactedThinkingBlockParam, TextBlockParam, ThinkingBlockParam } from '../../types/wire.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { mergeUserMessages } from './merge.js'

type ThinkingBlockType =
  | ThinkingBlock
  | RedactedThinkingBlock
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | ThinkingBlock
  | RedactedThinkingBlock

export function isThinkingBlock(
  block: ContentBlockParam | ContentBlock | ContentBlock,
): block is ThinkingBlockType {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

export function filterTrailingThinkingFromLastAssistant(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const lastMessage = messages.at(-1)
  if (!lastMessage || lastMessage.type !== 'assistant') {
    return messages
  }

  const content = lastMessage.message.content
  const lastBlock = content.at(-1)
  if (!lastBlock || !isThinkingBlock(lastBlock)) {
    return messages
  }

  let lastValidIndex = content.length - 1
  while (lastValidIndex >= 0) {
    const block = content[lastValidIndex]
    if (!block || !isThinkingBlock(block)) break
    lastValidIndex--
  }


  const filteredContent =
    lastValidIndex < 0
      ? [{ type: 'text' as const, text: '[No message content]', citations: [] }]
      : content.slice(0, lastValidIndex + 1)

  const result = [...messages]
  result[messages.length - 1] = {
    ...lastMessage,
    message: { ...lastMessage.message, content: filteredContent },
  }
  return result
}

function hasOnlyWhitespaceTextContent(
  content: Array<{ type: string; text?: string }>,
): boolean {
  if (content.length === 0) return false
  for (const block of content) {
    if (block.type !== 'text') return false
    if (block.text !== undefined && block.text.trim() !== '') return false
  }
  return true
}

export function filterWhitespaceOnlyAssistantMessages(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[]
export function filterWhitespaceOnlyAssistantMessages(
  messages: Message[],
): Message[]
export function filterWhitespaceOnlyAssistantMessages(
  messages: Message[],
): Message[] {
  let hasChanges = false

  const filtered = messages.filter(message => {
    if (message.type !== 'assistant') return true
    const content = message.message.content
    if (!Array.isArray(content) || content.length === 0) return true
    if (hasOnlyWhitespaceTextContent(content)) {
      hasChanges = true
      return false
    }
    return true
  })

  if (!hasChanges) return messages

  const merged: Message[] = []
  for (const message of filtered) {
    const prev = merged.at(-1)
    if (message.type === 'user' && prev?.type === 'user') {
      merged[merged.length - 1] = mergeUserMessages(prev, message)
    } else {
      merged.push(message)
    }
  }
  return merged
}

export function ensureNonEmptyAssistantContent(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  if (messages.length === 0) return messages

  let hasChanges = false
  const result = messages.map((message, index) => {
    if (message.type !== 'assistant') return message
    if (index === messages.length - 1) return message
    const content = message.message.content
    if (Array.isArray(content) && content.length === 0) {
      hasChanges = true
      return {
        ...message,
        message: {
          ...message.message,
          content: [
            { type: 'text' as const, text: NO_CONTENT_MESSAGE, citations: [] },
          ],
        },
      }
    }
    return message
  })

  return hasChanges ? result : messages
}

export function filterOrphanedThinkingOnlyMessages(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[]
export function filterOrphanedThinkingOnlyMessages(
  messages: Message[],
): Message[]
export function filterOrphanedThinkingOnlyMessages(
  messages: Message[],
): Message[] {
  const messageIdsWithNonThinkingContent = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    const hasNonThinking = content.some(
      block => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    )
    if (hasNonThinking && msg.message.id) {
      messageIdsWithNonThinkingContent.add(msg.message.id)
    }
  }

  return messages.filter(msg => {
    if (msg.type !== 'assistant') return true
    const content = msg.message.content
    if (!Array.isArray(content) || content.length === 0) return true

    const allThinking = content.every(
      block => block.type === 'thinking' || block.type === 'redacted_thinking',
    )
    if (!allThinking) return true
    if (
      msg.message.id &&
      messageIdsWithNonThinkingContent.has(msg.message.id)
    ) {
      return true
    }

    return false
  })
}

export function stripSignatureBlocks(messages: Message[]): Message[] {
  return stripThinkingFromIndex(messages, 0)
}

export function stripThinkingFromIndex<M extends Message>(
  messages: M[],
  fromIndex: number,
): M[] {
  let changed = false
  const result = messages.map((msg, index) => {
    if (index < fromIndex || msg.type !== 'assistant') return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const filtered = content.filter(block => !isThinkingBlock(block))
    if (filtered.length === content.length) return msg

    changed = true
    return {
      ...msg,
      message: { ...msg.message, content: filtered },
    } as typeof msg
  })
  return changed ? result : messages
}

export function filterUnresolvedToolUses(messages: Message[]): Message[] {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id)
    }
  }

  const unresolvedIds = new Set(
    [...toolUseIds].filter(id => !toolResultIds.has(id)),
  )
  if (unresolvedIds.size === 0) return messages

  return messages.filter(msg => {
    if (msg.type !== 'assistant') return true
    const content = msg.message.content
    if (!Array.isArray(content)) return true
    const toolUseBlockIds: string[] = []
    for (const b of content) {
      if (b.type === 'tool_use') toolUseBlockIds.push(b.id)
    }
    if (toolUseBlockIds.length === 0) return true
    return !toolUseBlockIds.every(id => unresolvedIds.has(id))
  })
}

export function sanitizeErrorToolResultContent(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return messages.map(msg => {
    if (msg.type !== 'user') return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    let changed = false
    const newContent = content.map(b => {
      if (b.type !== 'tool_result' || !b.is_error) return b
      const trContent = b.content
      if (!Array.isArray(trContent)) return b
      if (trContent.every(c => c.type === 'text')) return b
      changed = true
      const texts = trContent.filter(c => c.type === 'text').map(c => c.text)
      const textOnly: TextBlockParam[] =
        texts.length > 0 ? [{ type: 'text', text: texts.join('\n\n') }] : []
      return { ...b, content: textOnly }
    })
    if (!changed) return msg
    return { ...msg, message: { ...msg.message, content: newContent } }
  })
}
