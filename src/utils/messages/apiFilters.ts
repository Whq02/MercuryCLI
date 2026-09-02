// API-bound message filters — the invariants the live API enforces (no
// trailing thinking, non-whitespace text, non-empty content, signature
// validity, resolved tool_use pairing). The parity oracle (scripts/messages) pins behavior.

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

/**
 * The API rejects assistant messages that END with thinking/redacted_thinking.
 * Trim trailing thinking from the last message when it's an assistant; if
 * everything was thinking, substitute a placeholder text block.
 */
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

/** All-text and all-whitespace (any non-text block ⇒ valid message). */
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

/**
 * Drop assistant messages whose content is only whitespace text (the API
 * requires non-whitespace text blocks; mid-stream cancels can strand a bare
 * "\n\n"). Dropping can leave adjacent user messages — merge them back to
 * alternating roles. Also used by conversationRecovery on resume.
 */
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
      merged[merged.length - 1] = mergeUserMessages(prev, message) // lvalue
    } else {
      merged.push(message)
    }
  }
  return merged
}

/**
 * Non-final assistant messages must have non-empty content ("all messages
 * must have non-empty content except the optional final assistant message").
 * Insert the placeholder for empties; the final message may stay empty
 * (prefill).
 */
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

/**
 * Drop thinking-only assistant messages with no same-id sibling carrying
 * non-thinking content (compaction can slice away the sibling; the orphan
 * then 400s with "thinking blocks cannot be modified"). Same-id siblings
 * survive — normalizeMessagesForAPI merges them.
 */
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

/**
 * Strip signature-bearing thinking blocks from every assistant message —
 * signatures bind to the generating credential; after /logins they 400.
 * Thinking-only messages strip to [] on purpose: streaming splits same-id
 * siblings, the merge rejoins them, and an empty singleton is absorbed (true
 * orphans hit the empty-content placeholder path in normalizeMessagesForAPI).
 */
export function stripSignatureBlocks(messages: Message[]): Message[] {
  return stripThinkingFromIndex(messages, 0)
}

/**
 * Strip thinking/redacted_thinking blocks from every assistant message at
 * index ≥ `fromIndex`, leaving earlier messages untouched (identity when
 * nothing changes). The preserved-thinking law behind it: a thinking block
 * is bound to every message before it, so once a message at index k is
 * edited client-side (a cleared tool result, a dropped media item, a tail
 * re-homed behind a compaction summary), every thinking block from k on
 * would be rejected or dropped by the API — stripping exactly that run
 * client-side reproduces the drop deterministically, and the blocks before
 * k stay valid because their prefix and chain are intact. Text and
 * tool_use blocks always stay.
 */
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

/**
 * Drop assistant messages whose tool_use blocks ALL lack a tool_result.
 * Scans raw content blocks (NOT normalizeMessages — its derived uuids would
 * evade transcript dedup and grow the JSONL exponentially on resume).
 */
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

/**
 * Strip non-text blocks from is_error tool_results — the API rejects the mix
 * ("all content must be type text if is_error is true"). Read-side guard for
 * transcripts persisted before smooshIntoToolResult filtered on is_error;
 * without it a resumed session 400s forever. Text left beside a stripped
 * image re-merges.
 */
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
