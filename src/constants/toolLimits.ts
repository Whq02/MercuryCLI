
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

export function toolResultBudgetsForWindow(tokens?: number): { resultChars: number; messageChars: number } {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return { resultChars: DEFAULT_MAX_RESULT_SIZE_CHARS, messageChars: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS }
  }
  return {
    resultChars: Math.min(DEFAULT_MAX_RESULT_SIZE_CHARS, Math.max(8_000, Math.floor(tokens * 4 * 0.15))),
    messageChars: Math.min(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, Math.max(16_000, Math.floor(tokens * 4 * 0.3))),
  }
}
export const TOOL_SUMMARY_MAX_LENGTH = 50

export const REPEATED_RESULT_MIN_CHARS = 512
export const REPEATED_RESULT_TAG = 'Identical result:'
