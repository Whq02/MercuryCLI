import type { ContentBlock, ApiMessage } from '../../types/wire.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import isObject from 'lodash-es/isObject.js'
import { findToolByName, type Tools } from '../../Tool.js'
import { normalizeToolInput } from './api.js'
import { logForDebugging } from '../../utils/debug.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { contentBlocksOf } from '../../utils/messages/normalize.js'
import { requestConversationPlan } from './apiPlan.js'
export { isSystemLocalCommandMessage, reorderAttachmentsForAPI, stripToolReferenceBlocksFromUserMessage, stripUnavailableToolReferencesFromUserMessage, withToolReferenceTurnBoundary } from './apiViewRows.js'

type AnswerBlock = ApiMessage['content'][number]
type ToolAnswer = Extract<AnswerBlock, { type: 'tool_use' }>

export function normalizeContentFromAPI(contentBlocks: ApiMessage['content'], tools: Tools): ApiMessage['content'] {
  let present = contentBlocks || []
  if (present.some(block => block == null)) {
    logForDebugging('normalizeContentFromAPI: dropping null content block(s) from a provider response — not a decodable block shape', { level: 'warn' })
    present = present.filter(block => block != null)
  }
  return (contentBlocksOf(present) as ApiMessage['content']).map(block => decodeAnswerBlock(block, tools))
}

function decodeAnswerBlock(block: AnswerBlock, tools: Tools): AnswerBlock {
  if (block.type === 'tool_use') return { ...block, input: correctToolInput(block, tools) }
  return block.type === 'server_tool_use' && typeof block.input === 'string'
    ? { ...block, input: (safeParseJSON(block.input) ?? {}) as Record<string, unknown> }
    : block
}

function correctToolInput(block: ToolAnswer, tools: Tools): unknown {
  const input = parseToolInput(block)
  const tool = typeof input === 'object' && input !== null ? findToolByName(tools, block.name) : undefined
  if (!tool) return input
  try {
    return normalizeToolInput(tool, input as Record<string, unknown>)
  } catch (error) {
    logError(new Error('Error normalizing tool input: ' + error))
    return input
  }
}

function parseToolInput(block: ToolAnswer): unknown {
  const raw = block.input
  if (typeof raw !== 'string') {
    if (!isObject(raw)) throw new Error('Tool use input must be a string or object')
    return raw
  }
  const parsed = safeParseJSON(raw)
  if (parsed === null && raw.length > 0) {
    logForDebugging(`normalizeContentFromAPI: streamed tool_use input for ${block.name} failed to parse (${raw.length} chars); using empty input`, { level: 'error' })
  }
  return parsed ?? {}
}

export function normalizeMessagesForAPI(messages: Message[], tools: Tools = []): (UserMessage | AssistantMessage)[] {
  return requestConversationPlan(messages, tools).messages
}

const wireToolUse = (block: Extract<ContentBlock, { type: 'tool_use' }>) => ({
  type: 'tool_use' as const,
  id: block.id,
  name: block.name,
  input: block.input,
})

export function stripCallerFieldFromAssistantMessage(message: AssistantMessage): AssistantMessage {
  const carriesCaller = (block: ContentBlock): boolean =>
    block.type === 'tool_use' && 'caller' in block && block.caller !== null
  if (!message.message.content.some(carriesCaller)) return message
  const content = message.message.content.map(block => block.type === 'tool_use' ? wireToolUse(block) : block)
  return { ...message, message: { ...message.message, content } }
}
