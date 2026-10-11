import type { ContentBlock, ContentBlockParam, ApiMessage, ToolResultBlockParam } from '../../types/wire.js'
import type { AssistantMessage, AttachmentMessage, Message, SystemLocalCommandMessage, UserMessage } from '../../types/message.js'
import isObject from 'lodash-es/isObject.js'
import { findToolByName, type Tools } from '../../Tool.js'
import { STRIPPED_ADMISSION_RECORD_TEXT } from '../../tools/ToolSearchTool/prompt.js'
import { normalizeToolInput } from '../api.js'
import { logForDebugging } from '../debug.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { isToolReferenceBlock } from '../toolSearch.js'
import { contentBlocksOf } from './normalize.js'
import { requestConversationPlan } from './apiPlan.js'

type AnswerBlock = ApiMessage['content'][number]
type ToolAnswer = Extract<AnswerBlock, { type: 'tool_use' }>
type ResultItem = Extract<ToolResultBlockParam['content'], readonly unknown[]>[number]
type ReferencePolicy = (item: ResultItem) => boolean
const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

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

function resultArray(block: ContentBlockParam): block is ToolResultBlockParam & { content: ResultItem[] } {
  return block.type === 'tool_result' && Array.isArray(block.content)
}

function projectReferences(row: UserMessage, remove: ReferencePolicy, empty: ResultItem): UserMessage {
  const blocks = row.message.content
  if (!Array.isArray(blocks) || !blocks.some(block => resultArray(block) && block.content.some(remove))) return row
  const content = blocks.map(block => {
    if (!resultArray(block)) return block
    const kept = block.content.filter(item => !remove(item))
    return { ...block, content: kept.length ? kept : [{ ...empty }] }
  })
  return { ...row, message: { ...row.message, content } }
}

export function stripToolReferenceBlocksFromUserMessage(message: UserMessage): UserMessage {
  return projectReferences(message, isToolReferenceBlock, { type: 'text', text: STRIPPED_ADMISSION_RECORD_TEXT })
}

export function stripUnavailableToolReferencesFromUserMessage(message: UserMessage, availableToolNames: Set<string>): UserMessage {
  const unavailable: ReferencePolicy = item => {
    if (!isToolReferenceBlock(item)) return false
    const name = (item as { tool_name?: string }).tool_name
    return Boolean(name) && !availableToolNames.has(name!)
  }
  return projectReferences(message, unavailable, { type: 'text', text: '[Tool references removed - tools no longer available]' })
}

export function withToolReferenceTurnBoundary(message: UserMessage): UserMessage {
  const blocks = message.message.content
  if (!Array.isArray(blocks)) return message
  const hasBoundary = blocks.some(block => block.type === 'text' && block.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY))
  if (hasBoundary) return message
  const hasReference = blocks.some(block => resultArray(block) && block.content.some(isToolReferenceBlock))
  return !hasReference ? message : {
    ...message, message: { ...message.message, content: [...blocks, { type: 'text', text: TOOL_REFERENCE_TURN_BOUNDARY }] },
  }
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

export function isSystemLocalCommandMessage(message: Message): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

const anchorsAttachments = (message: Message): boolean =>
  message.type === 'assistant' ||
  (message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'tool_result')

export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  const ordered: Message[] = []
  let lifted: AttachmentMessage[] = []
  let rest: Message[] = []
  const closeSegment = (): void => {
    for (const attachment of lifted) ordered.push(attachment)
    for (const message of rest) ordered.push(message)
    lifted = []
    rest = []
  }
  for (const message of messages) {
    if (message.type === 'attachment') {
      lifted.push(message)
    } else if (anchorsAttachments(message)) {
      closeSegment()
      ordered.push(message)
    } else {
      rest.push(message)
    }
  }
  closeSegment()
  return ordered
}
