import type { ContentBlock, ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from './wire.js'
import type {
  AssistantMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  UserMessage,
} from './message.js'
import { createUserMessage } from './factories.js'
import { storedBlocksOf } from '../rows/content.js'
import { deriveUUID } from './identity.js'
import { parseReferences } from '../../sessions/promptHistory.js'

export function contentBlocksOf(content: unknown): (ContentBlock | ContentBlockParam)[] {
  return storedBlocksOf(content)
}

export let _normalizePassesForProof = 0

type RowsByLatch = { chained?: NormalizedMessage[]; unchained?: NormalizedMessage[] }

const ROWS_OF_PARENT = new WeakMap<Message, RowsByLatch>()

function remembered(parent: Message, latched: boolean, mint: () => NormalizedMessage[]): NormalizedMessage[] {
  let slot = ROWS_OF_PARENT.get(parent)
  if (!slot) ROWS_OF_PARENT.set(parent, (slot = {}))
  const key = latched ? 'chained' : 'unchained'
  return (slot[key] ??= mint())
}

const uuidOfRow = (parent: Message, latched: boolean, index: number): string =>
  latched ? deriveUUID(parent.uuid, index) : parent.uuid

function userTextRow(parent: UserMessage, text: string, latched: boolean): NormalizedMessage[] {
  return [
    {
      ...parent,
      uuid: uuidOfRow(parent, latched, 0),
      sourceUuid: parent.uuid,
      message: { ...parent.message, content: [{ type: 'text', text }] },
    } as NormalizedMessage,
  ]
}

export function normalizeMessages(messages: AssistantMessage[]): NormalizedAssistantMessage[]
export function normalizeMessages(messages: UserMessage[]): NormalizedUserMessage[]
export function normalizeMessages(messages: (AssistantMessage | UserMessage)[]): (NormalizedAssistantMessage | NormalizedUserMessage)[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  _normalizePassesForProof++
  let latched = false
  return messages.flatMap(message => {
    if (message.type === 'assistant') {
      const blocks = contentBlocksOf(message.message.content)
      latched ||= blocks.length > 1
      const chained = latched
      return remembered(message, chained, () => assistantRows(message, blocks, chained))
    }
    if (message.type === 'user') {
      const { content } = message.message
      const chainedSoFar = latched
      if (typeof content === 'string') return remembered(message, chainedSoFar, () => userTextRow(message, content, chainedSoFar))
      const blocks = contentBlocksOf(content)
      latched ||= blocks.length > 1
      const chained = latched
      return remembered(message, chained, () => userBlockRows(message, blocks, chained))
    }
    return [message]
  })
}

function assistantRows(parent: AssistantMessage, blocks: (ContentBlock | ContentBlockParam)[], latched: boolean): NormalizedMessage[] {
  return blocks.map(
    (block, index) =>
      ({
        type: 'assistant',
        timestamp: parent.timestamp,
        message: { ...parent.message, content: [block], context_management: parent.message.context_management ?? null },
        isMeta: parent.isMeta,
        isVirtual: parent.isVirtual,
        requestId: parent.requestId,
        uuid: uuidOfRow(parent, latched, index),
        error: parent.error,
        isApiErrorMessage: parent.isApiErrorMessage,
        ...(block.type === 'text' && parent.inReplyTo !== undefined ? { inReplyTo: parent.inReplyTo } : {}),
      }) as NormalizedMessage,
  )
}

export function imageRowNumbersOf(
  blocks: readonly (ContentBlock | ContentBlockParam)[],
  imagePasteIds?: readonly number[],
): readonly (number | null)[] {
  let imageCount = 0
  for (const block of blocks) {
    if (block.type === 'image') imageCount++
  }
  if (imageCount === 0) return []
  const named = new Set<number>()
  for (const block of blocks) {
    if (block.type === 'text') {
      for (const ref of parseReferences(block.text)) {
        if (ref.match.startsWith('[Image')) named.add(ref.id)
      }
    }
  }
  let ids: readonly number[]
  if (imagePasteIds !== undefined) {
    ids = imagePasteIds
  } else {
    const seen = new Set(named)
    for (let next = 1; seen.size < imageCount; next++) {
      seen.add(next)
    }
    ids = [...seen].sort((a, b) => a - b).slice(-imageCount)
  }
  return Array.from({ length: imageCount }, (_, index) => {
    const id = ids[index] ?? index + 1
    return named.has(id) ? null : id
  })
}

function userBlockRows(parent: UserMessage, blocks: (ContentBlock | ContentBlockParam)[], latched: boolean): NormalizedMessage[] {
  const numbers = imageRowNumbersOf(blocks, parent.imagePasteIds)
  let images = 0
  const rows: NormalizedMessage[] = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    const pasteId = block.type === 'image' ? numbers[images++] : undefined
    if (pasteId === null) continue
    rows.push({
      ...createUserMessage({
        content: [block],
        toolUseResult: parent.toolUseResult,
        mcpMeta: parent.mcpMeta,
        isMeta: parent.isMeta,
        isVisibleInTranscriptOnly: parent.isVisibleInTranscriptOnly,
        isVirtual: parent.isVirtual,
        timestamp: parent.timestamp,
        imagePasteIds: pasteId !== undefined ? [pasteId] : undefined,
        origin: parent.origin,
      }),
      ...(parent.queued === true ? { queued: true } : {}),
      ...(parent.heldFor === 'compaction' ? { heldFor: 'compaction' } : {}),
      uuid: uuidOfRow(parent, latched, index),
      sourceUuid: parent.uuid,
    } as NormalizedMessage)
  }
  return rows
}

type ToolUseRequestMessage = NormalizedAssistantMessage<ToolUseBlock>

export function isToolUseRequestMessage(message: Message): message is ToolUseRequestMessage {
  return message.type === 'assistant' && contentBlocksOf(message.message.content).some(block => block.type === 'tool_use')
}

type ToolUseResultMessage = NormalizedUserMessage & { message: { content: [ToolResultBlockParam] } }

export function isToolUseResultMessage(message: Message): message is ToolUseResultMessage {
  if (message.type !== 'user') return false
  const { content } = message.message
  return (Array.isArray(content) && content[0]?.type === 'tool_result') || Boolean(message.toolUseResult)
}
