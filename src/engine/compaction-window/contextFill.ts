import { clamp } from 'lodash-es'

export {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  has1mContext,
  modelSupports1M,
  getContextWindowForModel,
  getModelMaxOutputTokens,
  getMaxThinkingTokensForModel,
} from '../../models/facts/capabilities.js'

export const FOLD_MAX_OUTPUT_TOKENS = 20_000

type ContextUsage = {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_tokens: number
  output_tokens?: number
}

export function contextFillPercent(
  usedTokens: number | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (usedTokens === null || !(contextWindowSize > 0)) return { used: null, remaining: null }
  const used = clamp(Math.round(100 * (usedTokens / contextWindowSize)), 0, 100)
  return { used, remaining: 100 - used }
}

export function calculateContextPercentages(
  currentUsage: ContextUsage | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  const tokens = currentUsage === null ? null : currentUsage.input_tokens + currentUsage.cache_creation_input_tokens + currentUsage.cache_read_input_tokens + (currentUsage.output_tokens ?? 0)
  return contextFillPercent(tokens, contextWindowSize)
}
