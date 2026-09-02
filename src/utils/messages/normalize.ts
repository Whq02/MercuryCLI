// Message normalization — the one-block-per-message projection every renderer
// and lookup consumes, plus the tool-use/tool-result message discriminators.
// Owned Mercury module; the
// originals lived inline in utils/messages.ts. The parity oracle
// (scripts/messages) pins the split/uuid-derivation behavior exactly.

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

/** THE SHAPE OWNER (content-shape totality; prove-content-shape-totality):
 *  the wire type says Array<ContentBlock>, but the runtime stream (resume,
 *  foreign provider turns) can carry a string or worse — a bare `.map` on
 *  this field ended a session from the whole-chat memo (crash archive,
 *  origin app-root). An array passes through by reference; a
 *  string is the wire's own one-text-block equivalence; anything else
 *  degrades to zero blocks — one corrupt record drops, the transcript
 *  lives. Every raw-domain (pre-normalize) consumer in this directory
 *  routes through here or guards locally with Array.isArray; the prover
 *  inventories every direct chain. */
export function contentBlocksOf(content: unknown): (ContentBlock | ContentBlockParam)[] {
  if (Array.isArray(content)) return content as (ContentBlock | ContentBlockParam)[]
  if (typeof content === 'string') return [{ type: 'text', text: content, citations: [] }]
  return []
}

/** Proof seam (never product-read): counts normalization passes so the
 *  E03 reparse-zero law is instrumentable — resize/focus/unread changes
 *  must never re-run this walk (the Messages memo keys on [messages] only). */
export let _normalizePassesForProof = 0

/** CONTENT-KEYED ROW IDENTITY (the transcript calm law, chat-feel item 2):
 *  the split rows minted for a parent message OBJECT, cached per chain
 *  state. Every walk re-runs when the messages ARRAY identity moves (one
 *  append; every daemon transcript tick), and minting fresh row objects for
 *  unchanged parents defeated MessageRow's identity memo — the whole
 *  transcript re-rendered per landed record. Message objects are immutable
 *  in the stores that re-walk this (append-only state arrays; the daemon
 *  connector's content-keyed ticks), so an unchanged parent returns the
 *  SAME row objects and the row memo bails; a parent object that changed
 *  (fresh identity) mints fresh rows exactly as before. The walk's
 *  isNewChain latch is part of the key — a parent's rows differ under a
 *  latched chain (derived uuids) — so each parent caches the two variants
 *  independently and a boundary shift upstream can never replay the wrong
 *  uuids. Weakly keyed: a retired transcript takes its rows with it. */
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
/**
 * Split every multi-block turn message into one-block messages.
 *
 * uuid discipline: once ANY message in the walk has been split (>1 block),
 * every subsequent turn message gets derived uuids (parent uuid + block
 * index) — `isNewChain` latches — so ordering stays stable and no duplicate
 * uuids can reach the transcript. Progress/attachment/system messages pass
 * through untouched.
 */
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
          // Image blocks carry their own paste id from the parent's list.
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
    // stop_reason === 'tool_use' is unreliable — inspect the blocks.
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
