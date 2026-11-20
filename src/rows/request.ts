import { contentItemsOf, type ContentItem, type StoredBlock } from './content.js'

export interface RequestTurn<B extends { type: string } = StoredBlock> {
  role: 'user' | 'assistant'
  items: ContentItem<B>[]
  storedContent: unknown
  stringContent?: string
  messageId?: string
  servedModel?: string
  uuid?: string
  timestamp?: string
  replay?: { openai?: unknown; gemini?: unknown; xai?: unknown; openrouter?: unknown }
}

export function requestTurnOf<B extends { type: string } = StoredBlock>(
  role: RequestTurn['role'],
  content: string | null | undefined | readonly B[],
  facts?: Omit<RequestTurn, 'role' | 'items' | 'storedContent' | 'stringContent'>,
): RequestTurn<B>
export function requestTurnOf(
  role: RequestTurn['role'],
  content: unknown,
  facts?: Omit<RequestTurn, 'role' | 'items' | 'storedContent' | 'stringContent'>,
): RequestTurn
export function requestTurnOf(role: RequestTurn['role'], content: unknown, facts: Omit<RequestTurn, 'role' | 'items' | 'storedContent' | 'stringContent'> = {}): RequestTurn {
  return { role, items: contentItemsOf(content), storedContent: content, ...(typeof content === 'string' ? { stringContent: content } : {}), ...facts }
}
