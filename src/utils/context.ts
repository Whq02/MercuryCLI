import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  has1mContext,
  modelSupports1M,
  getContextWindowForModel,
  getModelMaxOutputTokens,
  getMaxThinkingTokensForModel,
} from './model/capabilities.js'

export const COMPACT_MAX_OUTPUT_TOKENS: Unbuilt = unbuilt('src/utils/context.ts:10')

type ContextUsage = Unbuilt

export function contextFillPercent(
  usedTokens: number | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  return notBuilt('src/utils/context.ts:19')
}

export function calculateContextPercentages(
  currentUsage: ContextUsage | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  return notBuilt('src/utils/context.ts:28')
}
