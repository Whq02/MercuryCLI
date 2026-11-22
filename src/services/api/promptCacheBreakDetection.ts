import type { Message } from '../../types/message.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type CacheLane = Unbuilt

type PromptStateSnapshot = Unbuilt

type PromptCacheBreakReceipt = Unbuilt


export function recordPromptState(snapshot: PromptStateSnapshot): void {
  return notBuilt('src/services/api/promptCacheBreakDetection.ts:252')
}

export async function checkResponseForCacheBreak(
  querySource: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: string | null,
  requestId?: string | null,
): Promise<void> {
  return notBuilt('src/services/api/promptCacheBreakDetection.ts:508')
}


export function notifyCacheDeletion(querySource: string, agentId?: string): void {
  return notBuilt('src/services/api/promptCacheBreakDetection.ts:606')
}

export function notifyCompaction(querySource: string, agentId?: string): void {
  return notBuilt('src/services/api/promptCacheBreakDetection.ts:614')
}

export function resetPromptCacheBreakDetection(): void {
  return notBuilt('src/services/api/promptCacheBreakDetection.ts:622')
}

export function recentCacheBreakReceipts(): readonly PromptCacheBreakReceipt[] {
  return notBuilt('src/services/api/promptCacheBreakDetection.ts:627')
}
