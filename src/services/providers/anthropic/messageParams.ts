
import type { QuerySource } from 'src/constants/querySource.js'
import {
  type AssistantMessage,
  type UserMessage,
} from '../../../types/message.js'
import type { MessageParam } from '../../../types/wire.js'
import { getCacheControl } from './requestParams.js'

type WireContent = MessageParam['content']
type WireBlock = Exclude<WireContent, string>[number]

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
