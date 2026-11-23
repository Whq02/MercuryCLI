import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../message-shapes/wire.js'
import type { AssistantMessage, Message, UserMessage } from '../message-shapes/message.js'
import { NO_CONTENT_MESSAGE } from '../message-shapes/noContentMessage.js'
import { DEAD_THINKING_PLACEHOLDER } from '../../models/facts/deadThinkingPlaceholder.js'
import { clientCallItemsOf, contentItemsOf, resultItemsOf } from '../rows/content.js'
import { isThinkingBlock } from '../message-shapes/thinkingBlock.js'
import { createUserMessage } from '../message-shapes/factories.js'
import { mergeUserMessages } from './merge.js'
import { ENDED_RUN_TOOL_RESULT } from '../message-shapes/rejectionText.js'

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

export { isThinkingBlock } from '../message-shapes/thinkingBlock.js'

function withoutThinking<M extends Message>(row: M, emptyText?: string): M {
  if (row.type !== 'assistant' || !Array.isArray(row.message.content)) return row
  const before = row.message.content
  const after = before.filter(block => !isThinkingBlock(block))
  return after.length === before.length ? row : withAssistantContent(row,
    after.length === 0 && emptyText !== undefined ? placeholder(emptyText) : after)
}

export function stripSignatureBlocks(messages: Message[]): Message[] {
  return stripThinkingFromIndex(messages, 0)
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
  const last = messages.at(-1)
  if (last?.type !== 'assistant' || !Array.isArray(last.message.content)) return messages
  const content = last.message.content
  let end = content.length
  while (end > 0 && isThinkingBlock(content[end - 1]!)) end--
  if (end === content.length) return messages
  const next = end === 0 ? placeholder(DEAD_THINKING_PLACEHOLDER) : content.slice(0, end)
  return [...messages.slice(0, -1), withAssistantContent(last, next)]
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
  const lastIndex = messages.length - 1
  return reviseRows(messages, (row, index) =>
    index < lastIndex && row.type === 'assistant' && Array.isArray(row.message.content) && row.message.content.length === 0
      ? withAssistantContent(row, placeholder(NO_CONTENT_MESSAGE))
      : row,
  )
}

export function filterWhitespaceOnlyAssistantMessages(messages: ConversationRow[]): ConversationRow[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  const kept = messages.filter(row => {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content) || row.message.content.length === 0) return true
    return !row.message.content.every(block => block.type === 'text' && (!block.text || block.text.trim() === ''))
  })
  if (kept.length === messages.length) return messages
  const merged: Message[] = []
  for (const row of kept) {
    const prev = merged.at(-1)
    if (row.type === 'user' && prev?.type === 'user') merged[merged.length - 1] = mergeUserMessages(prev, row)
    else merged.push(row)
  }
  return merged
}

export function filterOrphanedThinkingOnlyMessages(messages: ConversationRow[]): ConversationRow[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  const completeIds = new Set<string>()
  for (const row of messages) {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content) || !row.message.id) continue
    if (contentItemsOf(row.message.content).some(item => item.type !== 'reasoning')) completeIds.add(row.message.id)
  }
  return messages.filter(row => {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content) || row.message.content.length === 0) return true
    if (contentItemsOf(row.message.content).some(item => item.type !== 'reasoning')) return true
    return Boolean(row.message.id && completeIds.has(row.message.id))
  })
}

export function filterUnresolvedToolUses(messages: Message[]): Message[] {
  const called = new Set<string>()
  const answered = new Set<string>()
  for (const row of messages) {
    if ((row.type !== 'user' && row.type !== 'assistant') || !Array.isArray(row.message.content)) continue
    for (const item of clientCallItemsOf(row.message.content)) called.add(item.call_id)
    for (const item of resultItemsOf(row.message.content)) answered.add(item.call_id)
  }
  let hasUnanswered = false
  for (const id of called) {
    if (!answered.has(id)) {
      hasUnanswered = true
      break
    }
  }
  if (!hasUnanswered) return messages
  return messages.filter(row => {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content)) return true
    const calls = clientCallItemsOf(row.message.content)
    if (calls.length === 0) return true
    return calls.some(item => answered.has(item.call_id))
  })
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
  return messages.map(row => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return row
    if (!row.message.content.some(isMixedErrorResult)) return row
    const content = row.message.content.map(block => {
      if (!isMixedErrorResult(block)) return block
      const items = Array.isArray(block.content) ? block.content : []
      const textParts = items.filter((item): item is TextBlockParam => item.type === 'text').map(item => item.text ?? '')
      return { ...block, content: textParts.length > 0 ? [{ type: 'text' as const, text: textParts.join('\n\n') }] : [] }
    })
    return { ...row, message: { ...row.message, content } }
  })
}
