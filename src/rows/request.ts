import type { AssistantMessage, UserMessage } from '../types/message.js'
import { contentItemsOf, type ContentItem } from './content.js'

export interface RequestTurn {
  role: 'user' | 'assistant'
  items: ContentItem[]
  storedContent: unknown
  stringContent?: string
  messageId?: string
  uuid?: string
  timestamp?: string
  replay?: { openai?: unknown; gemini?: unknown; xai?: unknown; openrouter?: unknown }
}

export interface RequestPlan {
  turns: RequestTurn[]
  system?: string
  tools?: readonly unknown[]
  outputFormat?: unknown
}

export function requestTurnOf(role: RequestTurn['role'], content: unknown, facts: Omit<RequestTurn, 'role' | 'items' | 'storedContent' | 'stringContent'> = {}): RequestTurn {
  return { role, items: contentItemsOf(content), storedContent: content, ...(typeof content === 'string' ? { stringContent: content } : {}), ...facts }
}

export function requestPlanOf(messages: readonly (UserMessage | AssistantMessage)[], context: Omit<RequestPlan, 'turns'> = {}): RequestPlan {
  return {
    turns: messages.map(message => requestTurnOf(message.type, message.message.content, {
      uuid: message.uuid,
      timestamp: message.timestamp,
      ...(message.type === 'assistant' ? {
        messageId: message.message.id,
        replay: { openai: message.apexProviderTurn, gemini: message.geminiProviderTurn, xai: message.xaiProviderTurn, openrouter: message.openrouterProviderTurn },
      } : {}),
    })),
    ...context,
  }
}
