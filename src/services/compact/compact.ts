import type { ToolUseContext } from '../../Tool.js'
import type { NonNullableUsage } from '../../utils/api/emptyUsage.js'
import type { Message, UserMessage, CompactMetadata } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments/orchestrator.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../agents/forkedAgent.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { logError } from '../../utils/log.js'
import { createCompactBoundaryMessage, createUserMessage } from '../messages.js'
import { expandPath } from '../../utils/path.js'
import { reAppendSessionMetadata } from '../../utils/sessionStorage/logs.js'
import { recordContentReplacement } from '../../utils/sessionStorage/writer.js'
import { extractDiscoveredToolNames } from '../messages/toolSearch.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { releaseLspDocumentsForContext } from '../lsp/manager.js'
import { advanceContextEpoch, getContextEpoch } from '../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger, withKeptLedgerRows } from './foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../run/runContinuationCapsule.js'
import { getTurnReserveTokens } from '../../utils/compact/autoCompactWindow.js'
import { getCompactPrompt, renderFoldedWork } from './prompt.js'
import { computeVerbatimRecentTail, DEFAULT_KEEP_ROUNDS, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryCompactKeepTailEnabled, withFoldedResults } from './verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from '../../utils/compact/operatorMessages.js'
import { prepareFoldContext } from './foldTransaction.js'
import { renderFoldMemory, retireFoldToMemory, withdrawFoldMemory } from './foldRetirement.js'
import { carryFoldPrefix } from './cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../messages/apiFilters.js'
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, DEGRADED_SUMMARY_LENGTH, nothingToCompactLine } from './compact/limits.js'
import { type CompactionResult, type RecompactionInfo, foldDefersNow, buildPostCompactMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './compact/result.js'
import { mergeHookInstructions } from './compact/input.js'
import { collectPreservedReadPaths, obligationsOverThresholdMessage, restoreReadState, snapshotAndClearReadState, assembleAttachments } from './compact/attachments.js'
import { compactionBeforeHooks, compactionAfterHooks } from './compact/hooks.js'
import { notifyCompactionError, restoreAfterCompaction, withEngineModel } from './compact/status.js'
import { summariseForFold } from './compact/foldSummary.js'
import { chooseFoldTail } from './compact/foldTail.js'
import { landFold } from './compact/foldLanding.js'
import { composeFoldSummaryText, createFoldMeter } from './compact/foldMeasure.js'
import { notBuilt } from '../../pi/holes.js'

export { POST_COMPACT_MAX_FILES_TO_RESTORE, POST_COMPACT_TOKEN_BUDGET, POST_COMPACT_MAX_TOKENS_PER_FILE, POST_COMPACT_MAX_TOKENS_PER_SKILL, POST_COMPACT_SKILLS_TOKEN_BUDGET, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, NO_MESSAGES_TO_COMPACT, NOTHING_TO_COMPACT_KEY, isNothingToCompactMessage, nothingToCompactLine, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, ERROR_MESSAGE_PROMPT_TOO_LONG, ERROR_MESSAGE_USER_ABORT, ERROR_MESSAGE_INCOMPLETE_RESPONSE, ERROR_MESSAGE_NO_SUMMARY, PROSE_SKIPPED_KEY, MODEL_REFUSAL_STOP_KEY } from './compact/limits.js'
export { malformedHistoryRefusalOf, compactionRefusedForHistoryText, compactionPausedForHistoryText, foldRemedyIsHeadless, FOLD_WINDOW_REFUSAL_KEY, foldWindowRefusalText, CompactionRefusedForHistoryError } from './compact/refusals.js'
export { ERROR_MESSAGE_FOLD_TIMEOUT, setFoldBoundsForTests, foldStallMsFor, foldFirstByteAllowanceMs, shouldRideCacheSharingFork, foldFamilyOf } from './compact/foldBound.js'
export type { FoldBounds, FoldCut } from './compact/foldBound.js'
export { buildPostCompactMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './compact/result.js'
export type { CompactionResult, RecompactionInfo } from './compact/result.js'
export { boundedHookInstructions, mergeHookInstructions, isCompactCapsuleMessage, truncateHeadForPTLRetry, stripImagesFromMessages, stripReinjectedAttachments, createCompactCanUseTool } from './compact/input.js'
export { collectPreservedReadPaths, linesWithinTokenCeiling, fitFileAttachmentToTokenCeiling, createPostCompactFileAttachments, fitPostCompactUnderThreshold, createSkillAttachmentIfNeeded, createAsyncAgentAttachmentsIfNeeded, restorePreservedReads } from './compact/attachments.js'
export type { PostCompactFit } from './compact/attachments.js'
export { summaryAnswerFault, summaryRefusedByModel } from './compact/summaryCheck.js'
export { isPartSummaryMessage, splitTextForFold } from './compact/ladder.js'
export { withFoldStatus, withEngineModel } from './compact/status.js'
export { estimateFixedRequestTokens } from './compact/summariserFit.js'
export { isRefold, manualFoldHasNothingToFold, nothingToCompactReason, projectManualFold } from './compact/projection.js'
export type { ManualFoldProjection } from './compact/projection.js'
export { foldSizes } from './compact/foldMeasure.js'
export { partialCompactConversation } from './compact/partial.js'

void notifyCompaction

export { compactionAfterHooks }

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact?: boolean,
  recompactionInfo?: RecompactionInfo,
  overflow?: OverflowSignal,
  summaryModel?: string,
): Promise<CompactionResult> {
  return notBuilt('src/services/compact/compact.ts:64')
}
