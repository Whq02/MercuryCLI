import type { AssistantMessage, UserMessage } from '../../../types/message.js'
import type { MessageParam } from '../../../types/wire.js'
import { contentItemOf } from '../../../rows/content.js'
import { requestTurnOf, type RequestPlan, type RequestTurn } from '../../../rows/request.js'
import { getCacheControl } from './requestParams.js'

type WireContent = MessageParam['content']
type WireBlock = Exclude<WireContent, string>[number]

function canonicalWireBlock(block: WireBlock): WireBlock {
  if (contentItemOf(block).type !== 'tool_result') return block
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

function contentWithCacheMarker(turn: RequestTurn, enablePromptCaching: boolean): WireContent {
  if (turn.stringContent !== undefined) {
    return [{ type: 'text', text: turn.stringContent, ...(enablePromptCaching && { cache_control: getCacheControl() }) }]
  }
  return turn.items.map((item, index) => ({
    ...canonicalWireBlock(item.value as WireBlock),
    ...(index === turn.items.length - 1 && enablePromptCaching && (turn.role === 'user' || item.type !== 'reasoning') ? { cache_control: getCacheControl() } : {}),
  })) as WireContent
}

function encodeAnthropicTurn(turn: RequestTurn, addCache: boolean, enablePromptCaching: boolean): MessageParam {
  if (addCache) return { role: turn.role, content: contentWithCacheMarker(turn, enablePromptCaching) }
  const content = turn.role === 'assistant' ? turn.storedContent as WireContent
    : turn.stringContent !== undefined ? [{ type: 'text' as const, text: turn.stringContent }]
      : turn.items.map(item => canonicalWireBlock(item.value as WireBlock))
  return { role: turn.role, content }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
): MessageParam {
  return encodeAnthropicTurn(requestTurnOf('user', message.message.content), addCache, enablePromptCaching)
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
): MessageParam {
  return encodeAnthropicTurn(requestTurnOf('assistant', message.message.content), addCache, enablePromptCaching)
}

export function encodeAnthropicPlan(plan: RequestPlan, enablePromptCaching = false, cacheTurn = -1): MessageParam[] {
  return plan.turns.map((turn, index) => encodeAnthropicTurn(turn, index === cacheTurn, enablePromptCaching))
}
