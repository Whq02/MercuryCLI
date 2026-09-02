// providers/anthropic/messageParams — the Mercury message envelope projected onto the
// wire MessageParam, with the single-marker cache_control placement decided
// by the caller (addCacheBreakpoints owns WHICH message; this module owns
// WHERE inside it). Mercury-owned.

import type { QuerySource } from 'src/constants/querySource.js'
import {
  type AssistantMessage,
  type UserMessage,
} from '../../../types/message.js'
import type { MessageParam } from '../../../types/wire.js'
import { getCacheControl } from './requestParams.js'

type WireContent = MessageParam['content']
type WireBlock = Exclude<WireContent, string>[number]

/**
 * ONE wire spelling for a tool_result block, whatever road its row took.
 * The live tool runner spells the block id-first ({tool_use_id, type,
 * content}), the error factories spell {type, content, is_error,
 * tool_use_id}, and the session file stores a fabric record that the resume
 * loader re-encodes type-first ({type, tool_use_id, content, is_error}) —
 * so a resumed row and its live twin serialized differently. The
 * preserved-thinking check compares the conversation as SENT, so the bytes
 * must not depend on the road: every tool_result leaves here in the
 * codec's order (the resume road's own), other keys after. Other block
 * kinds pass through (tool_use and thinking already mint in that order).
 */
function canonicalWireBlock(block: WireBlock): WireBlock {
  if (block.type !== 'tool_result') return block
  const { type, tool_use_id, content, is_error, ...rest } = block as WireBlock & {
    tool_use_id: string
    content?: unknown
    is_error?: boolean
  }
  return {
    type,
    tool_use_id,
    ...(content !== undefined ? { content } : {}),
    ...(is_error !== undefined ? { is_error } : {}),
    ...rest,
  } as WireBlock
}

/**
 * Project one envelope's content for the marker-carrying message. String
 * content becomes a single text block; array content is re-blocked with the
 * marker on the LAST eligible block. Every block is shallow-copied here, so
 * marker placement never writes into the caller's message.
 *
 * `eligible` exists for the assistant side: thinking blocks reject
 * cache_control, so the marker must skip them even in last position.
 */
function contentWithCacheMarker(
  content: UserMessage['message']['content'] | AssistantMessage['message']['content'],
  enablePromptCaching: boolean,
  querySource: QuerySource | undefined,
  eligible: (blockType: string) => boolean,
): WireContent {
  if (typeof content === 'string') {
    return [
      {
        type: 'text',
        text: content,
        ...(enablePromptCaching && {
          cache_control: getCacheControl({ querySource }),
        }),
      },
    ]
  }
  const lastIndex = content.length - 1
  return content.map((block, i) => ({
    ...canonicalWireBlock(block as WireBlock),
    ...(i === lastIndex && enablePromptCaching && eligible(block.type)
      ? { cache_control: getCacheControl({ querySource }) }
      : {}),
  })) as WireContent
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    return {
      role: 'user',
      content: contentWithCacheMarker(
        message.message.content,
        enablePromptCaching,
        querySource,
        () => true,
      ),
    }
  }
  // Non-marker path: array content still gets a FRESH array (blocks shared).
  // Downstream splicers (insertCacheEditsBlock) mutate the array in place;
  // handing them the original would stack duplicate cache_edits into the
  // caller's message across repeated addCacheBreakpoints calls.
  //
  // String content becomes the same single text block the marker path
  // emits: a message is serialized identically whether or not it carries
  // the marker this request, so the marker moving one turn forward never
  // rewrites an earlier message's bytes (the preserved-thinking prefix and
  // the prompt cache both read the bytes as sent).
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? (message.message.content as WireBlock[]).map(canonicalWireBlock)
      : [{ type: 'text', text: message.message.content }],
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    return {
      role: 'assistant',
      content: contentWithCacheMarker(
        message.message.content,
        enablePromptCaching,
        querySource,
        blockType =>
          blockType !== 'thinking' && blockType !== 'redacted_thinking',
      ),
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}
