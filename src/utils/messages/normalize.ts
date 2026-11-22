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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

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
  return notBuilt('src/utils/messages/normalize.ts:94')
}

type ToolUseRequestMessage = Unbuilt

export function isToolUseRequestMessage(message: Message): message is ToolUseRequestMessage {
  return notBuilt('src/utils/messages/normalize.ts:116')
}

type ToolUseResultMessage = Unbuilt

export function isToolUseResultMessage(message: Message): message is ToolUseResultMessage {
  return notBuilt('src/utils/messages/normalize.ts:124')
}
