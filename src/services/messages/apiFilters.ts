import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { DEAD_THINKING_PLACEHOLDER } from '../../utils/model/deadThinkingPlaceholder.js'
import { clientCallItemsOf, contentItemsOf, resultItemsOf } from '../../rows/content.js'
import { isThinkingBlock } from '../../utils/messages/thinkingBlock.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { mergeUserMessages } from './merge.js'
import { ENDED_RUN_TOOL_RESULT } from '../../utils/messages/rejectionText.js'
import { notBuilt } from '../../pi/holes.js'

type ConversationRow = UserMessage | AssistantMessage
type AssistantContent = AssistantMessage['message']['content']

function reviseRows<M extends Message>(rows: M[], revise: (row: M, index: number) => M): M[] {
  let copy: M[] | undefined
  rows.forEach((row, index) => {
    const next = revise(row, index)
    if (next === row) return
    copy ??= rows.slice()
    copy[index] = next
  })
  return copy ?? rows
}

function withAssistantContent<M extends Message>(row: M, content: AssistantContent): M {
  const assistant = row as AssistantMessage
  return { ...assistant, message: { ...assistant.message, content } } as M
}

const placeholder = (text: string): AssistantContent => [{ type: 'text', text, citations: [] }]

export { isThinkingBlock } from '../../utils/messages/thinkingBlock.js'

function withoutThinking<M extends Message>(row: M, emptyText?: string): M {
  if (row.type !== 'assistant' || !Array.isArray(row.message.content)) return row
  const before = row.message.content
  const after = before.filter(block => !isThinkingBlock(block))
  return after.length === before.length ? row : withAssistantContent(row,
    after.length === 0 && emptyText !== undefined ? placeholder(emptyText) : after)
}

export function stripSignatureBlocks(messages: Message[]): Message[] {
  return notBuilt('src/services/messages/apiFilters.ts:42')
}

export function stripThinkingFromIndex<M extends Message>(messages: M[], fromIndex: number): M[] {
  return reviseRows(messages, (row, index) => index < fromIndex ? row : withoutThinking(row))
}

export function stripThinkingInPreservedTail<M extends Message>(messages: M[]): M[] {
  const boundary = messages[0]
  const segment = boundary?.type === 'system' && boundary.subtype === 'compact_boundary' ? boundary.compactMetadata.preservedSegment : undefined
  if (segment === undefined) return messages
  const head = messages.findIndex(row => row.uuid === segment.headUuid)
  const tail = messages.findIndex(row => row.uuid === segment.tailUuid)
  if (head < 0 || tail < head) return messages
  return reviseRows(messages, (row, index) => index >= head && index <= tail ? withoutThinking(row) : row)
}

type SameModel = (a: string, b: string, row: AssistantMessage) => boolean

function isOtherModel(row: Message, target: string, same: SameModel): row is AssistantMessage {
  return row.type === 'assistant' && typeof row.message.model === 'string' &&
    row.message.model.length > 0 && !same(row.message.model, target, row)
}

export function thinkingFromOtherModels(
  messages: readonly Message[], requestModel: string, sameModel: SameModel,
): { count: number; models: string[] } {
  const models = new Set<string>()
  const count = messages.reduce((total, row) => {
    if (!isOtherModel(row, requestModel, sameModel) || !Array.isArray(row.message.content)) return total
    const reasoning = row.message.content.filter(isThinkingBlock).length
    if (reasoning > 0) models.add(row.message.model)
    return total + reasoning
  }, 0)
  return { count, models: [...models] }
}

export function stripThinkingFromOtherModels<M extends Message>(
  messages: M[], requestModel: string, sameModel: SameModel,
): M[] {
  return reviseRows(messages, row => isOtherModel(row, requestModel, sameModel)
    ? withoutThinking(row, '[reasoning written by another model — not carried across the switch]')
    : row)
}

export function filterTrailingThinkingFromLastAssistant(messages: ConversationRow[]): ConversationRow[] {
  return notBuilt('src/services/messages/apiFilters.ts:88')
}

export function dropEmptyTextBlocks<M extends Message>(messages: M[]): M[] {
  return reviseRows(messages, row => {
    if (row.type === 'user') {
      const before = row.message.content
      if (typeof before === 'string') return before.length > 0 ? row : { ...row, message: { ...row.message, content: NO_CONTENT_MESSAGE } }
      const after = before.filter(block => block.type !== 'text' || block.text.length > 0)
      if (after.length === before.length && after.length > 0) return row
      return { ...row, message: { ...row.message, content: after.length > 0 ? after : [{ type: 'text', text: NO_CONTENT_MESSAGE }] } }
    }
    if (row.type !== 'assistant' || !Array.isArray(row.message.content) || row.message.content.length < 2) return row
    const before = row.message.content
    const after = before.filter(block => block.type !== 'text' || (typeof block.text === 'string' && block.text.trim() !== ''))
    return after.length > 0 && after.length !== before.length ? withAssistantContent(row, after) : row
  })
}

export function ensureNonEmptyAssistantContent(messages: ConversationRow[]): ConversationRow[] {
  return notBuilt('src/services/messages/apiFilters.ts:115')
}

export function filterWhitespaceOnlyAssistantMessages(messages: ConversationRow[]): ConversationRow[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  return notBuilt('src/services/messages/apiFilters.ts:130')
}

export function filterOrphanedThinkingOnlyMessages(messages: ConversationRow[]): ConversationRow[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  return notBuilt('src/services/messages/apiFilters.ts:143')
}

export function filterUnresolvedToolUses(messages: Message[]): Message[] {
  return notBuilt('src/services/messages/apiFilters.ts:157')
}

export function settleToolUsesOfEndedRun(messages: Message[]): Message[] {
  const answered = new Set<string>()
  for (const row of messages) {
    if ((row.type !== 'user' && row.type !== 'assistant') || !Array.isArray(row.message.content)) continue
    for (const item of resultItemsOf(row.message.content)) answered.add(item.call_id)
  }
  const settled: UserMessage[] = []
  let reply: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]!
    if (row.type === 'user') {
      if (!Array.isArray(row.message.content) || resultItemsOf(row.message.content).length === 0) break
      continue
    }
    if (row.type !== 'assistant') continue
    if (reply !== undefined && row.message.id !== reply) break
    reply = row.message.id
    const open = clientCallItemsOf(row.message.content).filter(item => !answered.has(item.call_id))
    settled.unshift(...open.map(item => createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: item.call_id, content: ENDED_RUN_TOOL_RESULT, is_error: true }],
      toolUseResult: ENDED_RUN_TOOL_RESULT,
      sourceToolAssistantUUID: row.uuid,
    })))
  }
  return filterUnresolvedToolUses(settled.length === 0 ? messages : [...messages, ...settled])
}

const isMixedErrorResult = (block: ContentBlockParam): block is ToolResultBlockParam =>
  block.type === 'tool_result' &&
  block.is_error === true &&
  Array.isArray(block.content) &&
  block.content.some(item => item.type !== 'text')

export function sanitizeErrorToolResultContent(messages: ConversationRow[]): ConversationRow[] {
  return notBuilt('src/services/messages/apiFilters.ts:213')
}
