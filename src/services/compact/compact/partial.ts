import type { ToolUseContext } from '../../../Tool.js'
import type { NonNullableUsage } from '../../../utils/api/emptyUsage.js'
import type { Message, PartialCompactDirection, UserMessage } from '../../../types/message.js'
import type { UUID } from 'node:crypto'
import { createAttachmentMessage } from '../../attachments/orchestrator.js'
import type { CacheSafeParams } from '../../agents/forkedAgent.js'
import { hookRowsOfResult } from '../../../utils/hooks/rows.js'
import { createCompactBoundaryMessage, createUserMessage, isCompactBoundaryMessage } from '../../messages.js'
import { reAppendSessionMetadata } from '../../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { tokenCountWithEstimation } from '../../context/tokens.js'
import { extractDiscoveredToolNames } from '../../messages/toolSearch.js'
import { APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import { releaseLspDocumentsForContext } from '../../lsp/manager.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger, withKeptLedgerRows } from '../foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { estimateContextTokens } from '../microCompact.js'
import { getCompactUserSummaryMessage, getPartialCompactPrompt, renderFoldedWork } from '../prompt.js'
import { selectOperatorMessages } from '../../../utils/compact/operatorMessages.js'
import { prepareFoldContext } from '../foldTransaction.js'
import { carryFoldPrefix } from '../cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../../providers/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { type CompactionResult, foldDefersNow, buildPostCompactMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './result.js'
import { boundedHookInstructions } from './input.js'
import { snapshotAndClearReadState, assembleAttachments } from './attachments.js'
import { validateSummary } from './summaryCheck.js'
import { summarizeWithPtlRetry } from './ladder.js'
import { compactionBeforeHooks, compactionAfterHooks } from './hooks.js'
import { notifyCompactionError, restoreAfterCompaction } from './status.js'
import { notBuilt } from '../../../pi/holes.js'

function isProgressMessage(message: Message): boolean {
  return message.type === 'progress'
}

export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction?: PartialCompactDirection,
): Promise<CompactionResult> {
  return notBuilt('src/services/compact/compact/partial.ts:37')
}
