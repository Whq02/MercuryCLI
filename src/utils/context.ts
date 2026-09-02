/**
 * Re-export shim for the per-model context-window capability surface (so
 * pre-existing import paths keep working) plus the provider-independent
 * context constants and percentage math.
 */
export {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  is1mContextDisabled,
  has1mContext,
  modelSupports1M,
  getContextWindowForModel,
  getSonnet1mExpTreatmentEnabled,
  getModelMaxOutputTokens,
  getMaxThinkingTokensForModel,
} from './model/capabilities.js'

/** Maximum output-token budget for compaction operations. */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

/**
 * Fleet telemetry put almost all real completions an order of magnitude
 * below the old 32k/64k reservation, so the large default was buying
 * scheduler slots nobody used; with this cap only a tiny minority of
 * requests hit the ceiling, and those are retried once at the escalated
 * value. Applied at the request-parameter layer (not here) to avoid an
 * import cycle.
 */
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

type ContextUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** The response's own output — part of the context the next request
   *  carries; absent on envelopes that never state it. */
  output_tokens?: number
}

/**
 * Used/remaining percentages of the context window from a token count.
 * A null count yields null for both; otherwise the count converts to a
 * rounded percentage clamped into [0, 100]. A non-positive window (unknown)
 * yields null rather than a division artefact.
 */
export function contextFillPercent(
  usedTokens: number | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (usedTokens === null || !(contextWindowSize > 0)) return { used: null, remaining: null }
  const used = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindowSize) * 100)))
  return { used, remaining: 100 - used }
}

/**
 * Used/remaining percentages of the context window from ONE response's
 * usage envelope: the full context that response ended at — input, both
 * cache families and its own output — the same figure the compaction
 * trigger reads. Null usage yields null for both.
 */
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
