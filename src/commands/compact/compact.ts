import { APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { getLastCacheSafeParams } from '../../services/agents/forkedAgent.js'
import { getUserContext } from '../../context.js'
import {
  compactConversation,
  buildPostCompactMessages,
  ERROR_MESSAGE_FOLD_TIMEOUT,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  type CompactionResult,
  isNothingToCompactMessage,
  isRefold,
  manualFoldHasNothingToFold,
  NO_MESSAGES_TO_COMPACT,
  nothingToCompactLine,
  nothingToCompactReason,
  projectManualFold,
  withFoldStatus,
  ERROR_MESSAGE_USER_ABORT,
} from '../../services/compact/compact.js'
import { manualCompactDisplayText, shouldEnrichForLiveDisplay } from '../../services/compact/manualReceipt.js'
import { foldModelFor, getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import { awaitContextWindowSource } from '../../services/context/contextWindowWarmup.js'
import { tokenCountWithEstimation } from '../../services/context/tokens.js'
import { logForDebugging } from '../../utils/debug.js'
import { suppressCompactWarning } from '../../services/compact/compactWarningState.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { shouldUseSessionMemoryCompaction, trySessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js'
import { setLastSummarizedMessageId } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import type { Message, UserMessage } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../services/messages.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { fetchSystemPromptParts } from '../../services/agents/queryContext.js'
import type { CacheSafeParams } from '../../services/agents/forkedAgent.js'
import { isAbortError, errorMessage, hasExactErrorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { notBuilt } from '../../pi/holes.js'

export { NOTHING_TO_COMPACT_KEY, nothingToCompactLine } from '../../services/compact/compact.js'

function enrichSummaryForLiveDisplay(
  result: CompactionResult,
  messagesHandedIn: number,
  customInstructions: string,
): void {
  const kept = result.messagesToKeep?.length ?? 0
  const computedCount = Math.max(0, messagesHandedIn - kept)

  const pre = result.preCompactTokenCount
  const post = result.truePostCompactTokenCount ?? result.postCompactTokenCount
  const pctValid = typeof pre === 'number' && pre > 0 && typeof post === 'number' && post >= 0
  const pct = pctValid ? Math.round(Math.min(100, Math.max(0, ((pre - post) / pre) * 100))) : undefined

  for (const summary of result.summaryMessages) {
    if (!summary.isCompactSummary) continue
    delete summary.isVisibleInTranscriptOnly
    const existing = summary.summarizeMetadata
    summary.summarizeMetadata = {
      ...existing,
      messagesSummarized: existing?.messagesSummarized ?? computedCount,
      ...(customInstructions ? { userContext: existing?.userContext ?? customInstructions } : {}),
      ...(pct !== undefined ? { contextReclaimedPct: pct } : {}),
      ...(pctValid ? { tokensBefore: pre, tokensAfter: post } : {}),
      ...(kept > 0 ? { keptMessages: kept } : {}),
    } as UserMessage['summarizeMetadata']
  }
}

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  return notBuilt('src/commands/compact/compact.ts:103')
}
