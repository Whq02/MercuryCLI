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
import { notBuilt } from '../../pi/holes.js'
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
  return notBuilt('src/services/messages/apiView.ts:25')
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

export function normalizeMessagesForAPI(messages: Message[], tools?: Tools): (UserMessage | AssistantMessage)[] {
  return notBuilt('src/services/messages/apiView.ts:57')
}

export function stripCallerFieldFromAssistantMessage(message: AssistantMessage): AssistantMessage {
  return notBuilt('src/services/messages/apiView.ts:68')
}
