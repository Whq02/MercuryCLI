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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function correctToolInput(block: ToolAnswer, tools: Tools): unknown {
  const parsed = parseToolInput(block)
  if (!isRecord(parsed)) return parsed
  const tool = findToolByName(tools, block.name)
  if (!tool) return parsed
  try {
    return normalizeToolInput(tool, parsed)
  } catch (error) {
    logError(new Error(`Error normalizing tool input: ${error}`))
    return parsed
  }
}

function decodeAnswerBlock(block: AnswerBlock, tools: Tools): AnswerBlock {
  if (block.type === 'tool_use') {
    return { ...block, input: correctToolInput(block, tools) }
  }
  if (block.type === 'server_tool_use' && typeof block.input === 'string') {
    return { ...block, input: safeParseJSON(block.input) ?? {} }
  }
  return block
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

function plainToolCall(block: ToolAnswer): ToolAnswer {
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
}

export function stripCallerFieldFromAssistantMessage(message: AssistantMessage): AssistantMessage {
  const blocks = message.message.content
  if (!Array.isArray(blocks) || !blocks.some(block => block.type === 'tool_use' && block.caller != null)) {
    return message
  }
  const content: ContentBlock[] = blocks.map(block => (block.type === 'tool_use' ? plainToolCall(block) : block))
  return { ...message, message: { ...message.message, content } }
}
