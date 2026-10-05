import { contentItemsOf, type ContentItem } from './content.js'

export interface RequestTurn {
  role: 'user' | 'assistant'
  items: ContentItem[]
  storedContent: unknown
  stringContent?: string
  messageId?: string
  servedModel?: string
  uuid?: string
  timestamp?: string
  replay?: { openai?: unknown; gemini?: unknown; xai?: unknown; openrouter?: unknown }
}

export function requestTurnOf(role: RequestTurn['role'], content: unknown, facts: Omit<RequestTurn, 'role' | 'items' | 'storedContent' | 'stringContent'> = {}): RequestTurn {
  return { role, items: contentItemsOf(content), storedContent: content, ...(typeof content === 'string' ? { stringContent: content } : {}), ...facts }
}
