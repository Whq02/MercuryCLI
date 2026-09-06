export {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  is1mContextDisabled,
  has1mContext,
  modelSupports1M,
  getContextWindowForModel,
  getModelMaxOutputTokens,
  getMaxThinkingTokensForModel,
} from './model/capabilities.js'

export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

type ContextUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens?: number
}

export function contextFillPercent(
  usedTokens: number | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (usedTokens === null || !(contextWindowSize > 0)) return { used: null, remaining: null }
  const used = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindowSize) * 100)))
  return { used, remaining: 100 - used }
}

export function calculateContextPercentages(
  currentUsage: ContextUsage | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (currentUsage === null) return { used: null, remaining: null }
  const total =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens +
    (currentUsage.output_tokens ?? 0)
  return contextFillPercent(total, contextWindowSize)
}
