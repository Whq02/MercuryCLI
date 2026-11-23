import { readRequestGauge } from '../run/requestGauge.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getTokenCountFromUsage } from '../../utils/tokenUsage.js'
export { getTokenCountFromUsage } from '../../utils/tokenUsage.js'
import { getTokenUsage, messageContextFill, type ContentBlockLike, type ContextFill } from './messageContextFill.js'
export { getTokenUsage, messageContextFill } from './messageContextFill.js'

export function usageAnchorModel(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (getTokenUsage(message) !== undefined) {
      const model = message?.type === 'assistant' ? message.message.model : undefined
      return typeof model === 'string' && model !== '' ? model : undefined
    }
  }
  return undefined
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (usage) return getTokenCountFromUsage(usage)
  }
  return 0
}

export function getCurrentUsage(messages: Message[]): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (usage) {
      return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      }
    }
  }
  return null
}

export function doesMostRecentAssistantMessageExceed200k(messages: Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue
    const usage = getTokenUsage(message)
    if (!usage) return false
    return getTokenCountFromUsage(usage) > 200_000
  }
  return false
}

export function getAssistantMessageContentLength(message: AssistantMessage): number {
  const content = message.message.content
  if (!Array.isArray(content)) return 0
  const blocks: readonly ContentBlockLike[] = content
  let length = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      length += block.text.length
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      length += block.thinking.length
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      length += block.data.length
    } else if (block.type === 'tool_use' && block.input !== undefined) {
      length += JSON.stringify(block.input).length
    }
  }
  return length
}
function requestFill(messages: readonly Message[], model?: string): ContextFill {
  const request = readRequestGauge(messages, model)
  return request ? { tokens: request.tokens, source: request.source } : messageContextFill(messages, model)
}

export function contextFill(messages: readonly Message[], model?: string): ContextFill {
  const fill = requestFill(messages, model)
  const boundary = fill.source === 'estimate' ? messages.findLast(row => row.type === 'system' && row.subtype === 'compact_boundary') : undefined
  const fold = boundary?.type === 'system' && boundary.subtype === 'compact_boundary' ? boundary.compactMetadata : undefined
  if (fold?.postTokens === undefined || fold.postEstimate === undefined || (model !== undefined && model !== fold.postEstimate.model)) return fill
  return { tokens: Math.max(fold.postTokens, fill.tokens - (fold.postEstimate.tokens - fold.postTokens)), source: 'estimate' }
}

export function tokenCountWithEstimation(messages: readonly Message[], model?: string): number {
  return requestFill(messages, model).tokens
}
