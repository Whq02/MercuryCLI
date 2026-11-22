import { readRequestGauge } from '../run/requestGauge.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getTokenCountFromUsage } from '../../utils/tokenUsage.js'
export { getTokenCountFromUsage } from '../../utils/tokenUsage.js'
import { getTokenUsage, messageContextFill, type ContentBlockLike, type ContextFill } from './messageContextFill.js'
import { notBuilt } from '../../pi/holes.js'
export { getTokenUsage, messageContextFill } from './messageContextFill.js'

export function usageAnchorModel(messages: readonly Message[]): string | undefined {
  return notBuilt('src/services/context/tokens.ts:8')
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  return notBuilt('src/services/context/tokens.ts:18')
}

export function getCurrentUsage(messages: Message[]): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} | null {
  return notBuilt('src/services/context/tokens.ts:26')
}

export function doesMostRecentAssistantMessageExceed200k(messages: Message[]): boolean {
  return notBuilt('src/services/context/tokens.ts:45')
}

export function getAssistantMessageContentLength(message: AssistantMessage): number {
  return notBuilt('src/services/context/tokens.ts:56')
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
  return notBuilt('src/services/context/tokens.ts:87')
}
