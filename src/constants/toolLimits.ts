import { unbuilt, type Unbuilt } from '../pi/holes.js'

export const DEFAULT_MAX_RESULT_SIZE_CHARS: Unbuilt = unbuilt('src/constants/toolLimits.ts:2')

export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS: Unbuilt = unbuilt('src/constants/toolLimits.ts:4')

export function toolResultBudgetsForWindow(tokens?: number): { resultChars: number; messageChars: number } {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return { resultChars: DEFAULT_MAX_RESULT_SIZE_CHARS, messageChars: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS }
  }
  return {
    resultChars: Math.max(DEFAULT_MAX_RESULT_SIZE_CHARS, Math.floor(tokens * 4 * 0.15)),
    messageChars: Math.max(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, Math.floor(tokens * 4 * 0.3)),
  }
}
export const TOOL_SUMMARY_MAX_LENGTH: Unbuilt = unbuilt('src/constants/toolLimits.ts:15')

export const REPEATED_RESULT_MIN_CHARS = 512
export const REPEATED_RESULT_TAG = 'Identical result:'
