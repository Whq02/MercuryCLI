// providers/anthropic/media — request-chain threading (previous request id) and the
// media-budget strip that keeps a request under the API's image/document
// ceiling. Mercury-owned.

import {
  type AssistantMessage,
  type Message,
  type UserMessage,
} from '../../../types/message.js'
import {
  type ContentBlockParam,
  type DocumentBlockParam,
  type ImageBlockParam,
  type ToolResultBlockParam,
} from '../../../types/wire.js'
import { stripThinkingFromIndex } from '../../../utils/messages/apiFilters.js'

/**
 * Newest assistant requestId in the array, or undefined before the first
 * response. Reading it off the message array — never off global state —
 * gives each chain (main thread, every subagent, every teammate) its own
 * request lineage for cache-hit and incremental-token joins, and makes
 * rollback/undo self-correcting: a removed message simply stops being the
 * newest.
 */
export function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

export function isMedia(
  block: ContentBlockParam,
): block is ImageBlockParam | DocumentBlockParam {
  return block.type === 'image' || block.type === 'document'
}

export function isToolResult(
  block: ContentBlockParam,
): block is ToolResultBlockParam {
  return block.type === 'tool_result'
}

/** Count media blocks in one message: top-level plus tool_result-nested. */
function countMediaInMessage(msg: UserMessage | AssistantMessage): number {
  const content = msg.message.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (isMedia(block)) n++
    if (isToolResult(block) && Array.isArray(block.content)) {
      for (const nested of block.content) {
        if (isMedia(nested as ContentBlockParam)) n++
      }
    }
  }
  return n
}

/**
 * Enforce the per-request media ceiling by dropping the OLDEST media first —
 * recency is what the model still needs. Within each message the strip
 * clears tool_result-nested media before top-level blocks, walking messages
 * oldest→newest until the overage is paid off.
 *
 * Untouched messages pass through by reference; a message loses its identity
 * only when a block was actually removed (fresh message/content objects,
 * original never mutated).
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = -limit
  for (const msg of messages) {
    toRemove += countMediaInMessage(msg)
  }
  if (toRemove <= 0) return messages

  const stripped = messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const debtBefore = toRemove
    const remaining = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        ) {
          return block
        }
        const kept = block.content.filter(nested => {
          if (toRemove > 0 && isMedia(nested as ContentBlockParam)) {
            toRemove--
            return false
          }
          return true
        })
        return kept.length === block.content.length
          ? block
          : { ...block, content: kept }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return debtBefore === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: remaining },
        }
  }) as (UserMessage | AssistantMessage)[]
  // Dropping a media item edits an earlier turn: the thinking blocks after
  // the first edited message are bound to the un-stripped bytes and would be
  // rejected or dropped by the preserved-thinking check — strip that run so
  // the request is valid by construction.
  const firstEdited = stripped.findIndex((msg, index) => msg !== messages[index])
  return firstEdited === -1 ? stripped : stripThinkingFromIndex(stripped, firstEdited)
}
