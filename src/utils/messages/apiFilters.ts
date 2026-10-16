import type { ContentBlock, RedactedThinkingBlock, ThinkingBlock, ContentBlockParam, RedactedThinkingBlockParam, TextBlockParam, ThinkingBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { DEAD_THINKING_PLACEHOLDER } from '../../services/providers/anthropic/deadThinkingPlaceholder.js'
import { clientCallItemsOf, contentItemsOf, isReasoningContent, resultItemsOf } from '../../rows/content.js'
import { mergeUserMessages } from './merge.js'

type ThinkingBlockType = ThinkingBlock | RedactedThinkingBlock | ThinkingBlockParam | RedactedThinkingBlockParam
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

export function isThinkingBlock(block: ContentBlockParam | ContentBlock): block is ThinkingBlockType {
  return isReasoningContent(block)
}

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

function isOtherModel(row: Message, target: string, same: (a: string, b: string) => boolean): row is AssistantMessage {
  return row.type === 'assistant' && typeof row.message.model === 'string' &&
    row.message.model.length > 0 && !same(row.message.model, target)
}

export function thinkingFromOtherModels(
  messages: readonly Message[], requestModel: string, sameModel: (a: string, b: string) => boolean,
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
  messages: M[], requestModel: string, sameModel: (a: string, b: string) => boolean,
): M[] {
  return reviseRows(messages, row => isOtherModel(row, requestModel, sameModel)
    ? withoutThinking(row, '[reasoning written by another model — not carried across the switch]')
    : row)
}

export function filterTrailingThinkingFromLastAssistant(messages: ConversationRow[]): ConversationRow[] {
  const final = messages.at(-1)
  if (final?.type !== 'assistant') return messages
  const blocks = final.message.content
  const tail = blocks.at(-1)
  if (!tail || !isThinkingBlock(tail)) return messages
  const end = blocks.findLastIndex(block => !block || !isThinkingBlock(block)) + 1
  return [...messages.slice(0, -1), withAssistantContent(final,
    end === 0 ? placeholder(DEAD_THINKING_PLACEHOLDER) : blocks.slice(0, end))]
}

export function dropEmptyTextBlocks<M extends Message>(messages: M[]): M[] {
  return reviseRows(messages, row => {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content) || row.message.content.length < 2) return row
    const before = row.message.content
    const after = before.filter(block => block.type !== 'text' || (typeof block.text === 'string' && block.text.trim() !== ''))
    return after.length > 0 && after.length !== before.length ? withAssistantContent(row, after) : row
  })
}

export function ensureNonEmptyAssistantContent(messages: ConversationRow[]): ConversationRow[] {
  return reviseRows(messages, (row, index) => row.type === 'assistant' && index < messages.length - 1 &&
    Array.isArray(row.message.content) && row.message.content.length === 0
    ? withAssistantContent(row, placeholder(NO_CONTENT_MESSAGE)) : row)
}

function isBlankAssistant(row: Message): boolean {
  if (row.type !== 'assistant' || !Array.isArray(row.message.content)) return false
  const blocks = row.message.content
  return blocks.length > 0 && blocks.every(block => block.type === 'text' &&
    (block.text === undefined || block.text.trim() === ''))
}

export function filterWhitespaceOnlyAssistantMessages(messages: ConversationRow[]): ConversationRow[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  const kept = messages.filter(row => !isBlankAssistant(row))
  if (kept.length === messages.length) return messages
  return kept.reduce<Message[]>((out, row) => {
    const previous = out.at(-1)
    if (previous?.type === 'user' && row.type === 'user') out[out.length - 1] = mergeUserMessages(previous, row)
    else out.push(row)
    return out
  }, [])
}

export function filterOrphanedThinkingOnlyMessages(messages: ConversationRow[]): ConversationRow[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  const candidates = new Set<Message>()
  const completeIds = new Set<string>()
  for (const row of messages) {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content)) continue
    const items = contentItemsOf(row.message.content)
    if (items.some(item => item.type !== 'reasoning')) {
      if (row.message.id) completeIds.add(row.message.id)
    } else if (row.message.content.length > 0) candidates.add(row)
  }
  return messages.filter(row => !candidates.has(row) ||
    (row.type === 'assistant' && Boolean(row.message.id) && completeIds.has(row.message.id)))
}

export function filterUnresolvedToolUses(messages: Message[]): Message[] {
  const answered = new Set<string>()
  const calls = new Map<Message, string[]>()
  for (const row of messages) {
    if ((row.type !== 'user' && row.type !== 'assistant') || !Array.isArray(row.message.content)) continue
    calls.set(row, clientCallItemsOf(row.message.content).map(item => item.call_id))
    for (const item of resultItemsOf(row.message.content)) answered.add(item.call_id)
  }
  if (![...calls.values()].some(ids => ids.some(id => !answered.has(id)))) return messages
  return messages.filter(row => {
    const ids = calls.get(row)
    return row.type !== 'assistant' || !ids?.length || ids.some(id => answered.has(id))
  })
}

const isMixedErrorResult = (block: ContentBlockParam): block is ToolResultBlockParam =>
  block.type === 'tool_result' &&
  block.is_error === true &&
  Array.isArray(block.content) &&
  block.content.some(item => item.type !== 'text')

function textOnlyResult(block: ToolResultBlockParam): ToolResultBlockParam {
  const texts = (block.content as ReadonlyArray<{ type: string; text?: string }>).flatMap(item =>
    item.type === 'text' ? [item.text ?? ''] : [],
  )
  const content: TextBlockParam[] = texts.length ? [{ type: 'text', text: texts.join('\n\n') }] : []
  return { ...block, content }
}

export function sanitizeErrorToolResultContent(messages: ConversationRow[]): ConversationRow[] {
  return messages.map(msg => {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) return msg
    const before = msg.message.content
    const after = before.map(block => (isMixedErrorResult(block) ? textOnlyResult(block) : block))
    const untouched = after.every((block, index) => block === before[index])
    return untouched ? msg : { ...msg, message: { ...msg.message, content: after } }
  })
}
