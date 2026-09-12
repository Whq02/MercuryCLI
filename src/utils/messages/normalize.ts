
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
import { deriveUUID } from './identity.js'

export function contentBlocksOf(content: unknown): (ContentBlock | ContentBlockParam)[] {
  if (Array.isArray(content)) return content as (ContentBlock | ContentBlockParam)[]
  if (typeof content === 'string') return [{ type: 'text', text: content, citations: [] }]
  return []
}

export let _normalizePassesForProof = 0

const NORMALIZED_BY_MESSAGE = new WeakMap<
  Message,
  { chained?: NormalizedMessage[]; unchained?: NormalizedMessage[] }
>()

function normalizedCacheGet(
  message: Message,
  chained: boolean,
): NormalizedMessage[] | undefined {
  const slot = NORMALIZED_BY_MESSAGE.get(message)
  return slot === undefined ? undefined : chained ? slot.chained : slot.unchained
}

function normalizedCacheSet(
  message: Message,
  chained: boolean,
  rows: NormalizedMessage[],
): void {
  let slot = NORMALIZED_BY_MESSAGE.get(message)
  if (slot === undefined) {
    slot = {}
    NORMALIZED_BY_MESSAGE.set(message, slot)
  }
  if (chained) slot.chained = rows
  else slot.unchained = rows
}

export function normalizeMessages(
  messages: AssistantMessage[],
): NormalizedAssistantMessage[]
export function normalizeMessages(
  messages: UserMessage[],
): NormalizedUserMessage[]
export function normalizeMessages(
  messages: (AssistantMessage | UserMessage)[],
): (NormalizedAssistantMessage | NormalizedUserMessage)[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  _normalizePassesForProof++
  let isNewChain = false
  return messages.flatMap(message => {
    switch (message.type) {
      case 'assistant': {
        const content = contentBlocksOf(message.message.content)
        isNewChain = isNewChain || content.length > 1
        const cached = normalizedCacheGet(message, isNewChain)
        if (cached !== undefined) return cached
        const rows = content.map((block, index) => {
          const uuid = isNewChain
            ? deriveUUID(message.uuid, index)
            : message.uuid
          return {
            type: 'assistant' as const,
            timestamp: message.timestamp,
            message: {
              ...message.message,
              content: [block],
              context_management: message.message.context_management ?? null,
            },
            isMeta: message.isMeta,
            isVirtual: message.isVirtual,
            requestId: message.requestId,
            uuid,
            error: message.error,
            isApiErrorMessage: message.isApiErrorMessage,
            advisorModel: message.advisorModel,
          } as NormalizedAssistantMessage
        })
        normalizedCacheSet(message, isNewChain, rows)
        return rows
      }
      case 'attachment':
      case 'progress':
      case 'system':
        return [message]
      case 'user': {
        if (typeof message.message.content === 'string') {
          const cachedString = normalizedCacheGet(message, isNewChain)
          if (cachedString !== undefined) return cachedString
          const uuid = isNewChain ? deriveUUID(message.uuid, 0) : message.uuid
          const rows = [
            {
              ...message,
              uuid,
              message: {
                ...message.message,
                content: [{ type: 'text', text: message.message.content }],
              },
            } as NormalizedMessage,
          ]
          normalizedCacheSet(message, isNewChain, rows)
          return rows
        }
        const content = contentBlocksOf(message.message.content)
        isNewChain = isNewChain || content.length > 1
        const cached = normalizedCacheGet(message, isNewChain)
        if (cached !== undefined) return cached
        let imageIndex = 0
        const rows = content.map((block, index) => {
          const isImage = block.type === 'image'
          const imageId =
            isImage && message.imagePasteIds
              ? message.imagePasteIds[imageIndex]
              : undefined
          if (isImage) imageIndex++
          return {
            ...createUserMessage({
              content: [block],
              toolUseResult: message.toolUseResult,
              mcpMeta: message.mcpMeta,
              isMeta: message.isMeta,
              isVisibleInTranscriptOnly: message.isVisibleInTranscriptOnly,
              isVirtual: message.isVirtual,
              timestamp: message.timestamp,
              imagePasteIds: imageId !== undefined ? [imageId] : undefined,
              origin: message.origin,
            }),
            ...(message.queued === true ? { queued: true as const } : {}),
            ...(message.heldFor === 'compaction' ? { heldFor: 'compaction' as const } : {}),
            uuid: isNewChain ? deriveUUID(message.uuid, index) : message.uuid,
          } as NormalizedMessage
        })
        normalizedCacheSet(message, isNewChain, rows)
        return rows
      }
    }
  })
}

export type ToolUseRequestMessage = NormalizedAssistantMessage & {
  message: { content: [ToolUseBlock] }
}

export function isToolUseRequestMessage(
  message: Message,
): message is ToolUseRequestMessage {
  return (
    message.type === 'assistant' &&
    contentBlocksOf(message.message.content).some(block => block.type === 'tool_use')
  )
}

export type ToolUseResultMessage = NormalizedUserMessage & {
  message: { content: [ToolResultBlockParam] }
}

export function isToolUseResultMessage(
  message: Message,
): message is ToolUseResultMessage {
  return (
    message.type === 'user' &&
    ((Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'tool_result') ||
      Boolean(message.toolUseResult))
  )
}
