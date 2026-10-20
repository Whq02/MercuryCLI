import type { ContentBlock, ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from '../../types/wire.js'
import type {
  AssistantMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  UserMessage,
} from '../../types/message.js'
import { createUserMessage } from './factories.js'
import { storedBlocksOf } from '../../rows/content.js'
import { deriveUUID } from './identity.js'

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

function assistantRows(parent: AssistantMessage, blocks: (ContentBlock | ContentBlockParam)[], latched: boolean): NormalizedMessage[] {
  return blocks.map(
    (block, index) =>
      ({
        type: 'assistant' as const,
        timestamp: parent.timestamp,
        message: { ...parent.message, content: [block], context_management: parent.message.context_management ?? null },
        isMeta: parent.isMeta,
        isVirtual: parent.isVirtual,
        requestId: parent.requestId,
        uuid: uuidOfRow(parent, latched, index),
        error: parent.error,
        isApiErrorMessage: parent.isApiErrorMessage,
        ...(parent.inReplyTo !== undefined && block.type === 'text' ? { inReplyTo: parent.inReplyTo } : {}),
      }) as NormalizedAssistantMessage,
  )
}

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

function userBlockRows(parent: UserMessage, blocks: (ContentBlock | ContentBlockParam)[], latched: boolean): NormalizedMessage[] {
  let imagesSeen = 0
  const dress = {
    ...(parent.queued === true ? { queued: true as const } : {}),
    ...(parent.heldFor === 'compaction' ? { heldFor: 'compaction' as const } : {}),
  }
  return blocks.map((block, index) => {
    const pasteId = block.type === 'image' && parent.imagePasteIds ? parent.imagePasteIds[imagesSeen++] : undefined
    return {
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
      ...dress,
      uuid: uuidOfRow(parent, latched, index),
      sourceUuid: parent.uuid,
    } as NormalizedMessage
  })
}

export function normalizeMessages(messages: AssistantMessage[]): NormalizedAssistantMessage[]
export function normalizeMessages(messages: UserMessage[]): NormalizedUserMessage[]
export function normalizeMessages(messages: (AssistantMessage | UserMessage)[]): (NormalizedAssistantMessage | NormalizedUserMessage)[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  _normalizePassesForProof++
  let latched = false
  const widen = (blocks: unknown[]): boolean => (latched ||= blocks.length > 1)
  const rowsOf = (message: Message): NormalizedMessage[] => {
    if (message.type === 'assistant') {
      const blocks = contentBlocksOf(message.message.content)
      return remembered(message, widen(blocks), () => assistantRows(message, blocks, latched))
    }
    if (message.type !== 'user') return [message]
    const content = message.message.content
    if (typeof content === 'string') return remembered(message, latched, () => userTextRow(message, content, latched))
    const blocks = contentBlocksOf(content)
    return remembered(message, widen(blocks), () => userBlockRows(message, blocks, latched))
  }
  return messages.flatMap(rowsOf)
}

type ToolUseRequestMessage = NormalizedAssistantMessage & {
  message: { content: [ToolUseBlock] }
}

export function isToolUseRequestMessage(message: Message): message is ToolUseRequestMessage {
  return message.type === 'assistant' && contentBlocksOf(message.message.content).some(block => block.type === 'tool_use')
}

type ToolUseResultMessage = NormalizedUserMessage & {
  message: { content: [ToolResultBlockParam] }
}

export function isToolUseResultMessage(message: Message): message is ToolUseResultMessage {
  if (message.type !== 'user') return false
  const content = message.message.content
  return (Array.isArray(content) && content[0]?.type === 'tool_result') || Boolean(message.toolUseResult)
}
