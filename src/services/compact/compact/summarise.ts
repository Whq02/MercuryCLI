import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, Message, UserMessage } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import { continuationOfSentRequest, lastSentRequestFor, runForkedAgent, type CacheSafeParams } from '../../agents/forkedAgent.js'
import { appendSystemContext } from '../../messages/api.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { logError } from '../../../utils/log.js'
import { findLastCompactBoundaryIndex, getAssistantMessageText } from '../../messages.js'
import { isSessionActivityTrackingActive, sendSessionActivitySignal } from '../../../utils/sessionActivity.js'
import { tokenCountWithEstimation } from '../../context/tokens.js'
import { isToolSearchEnabled } from '../../messages/toolSearch.js'
import { sleep } from '../../../utils/sleep.js'
import { LOCAL_WINDOW_REMEDY, localFitRefusalFacts } from '../../providers/local/localCatalogue.js'
import { routedCallModel, settleAssistantTurn } from '../../providers/callModelRouter.js'
import { coldPrefixOf } from '../../providers/streamIdleBudget.js'
import { getRetryDelay } from '../../api/withRetry.js'
import { APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import { rosterOwnerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { FileReadTool } from '../../../tools/FileReadTool/FileReadTool.js'
import { ToolSearchTool } from '../../../tools/ToolSearchTool/ToolSearchTool.js'
import { projectRewoundWindows } from '../checkpointRewind.js'
import { ERROR_MESSAGE_INCOMPLETE_RESPONSE, KEEPALIVE_INTERVAL_MS } from './limits.js'
import { isOverflowAnswer, malformedHistoryRefusalOf, foldRemedyIsHeadless, foldWindowRefusalText, CompactionRefusedForHistoryError } from './refusals.js'
import { ERROR_MESSAGE_FOLD_TIMEOUT, type FoldBound, armFoldBound, foldCutWords, shouldRideCacheSharingFork, recordFoldRoad } from './foldBound.js'
import { createCompactCanUseTool } from './input.js'
import { summaryAnswerFault, summaryRefusedByModel } from './summaryCheck.js'
import { startInterval, stopInterval } from '../../../utils/timers.js'
import { notBuilt } from '../../../pi/holes.js'

export async function runSummarization(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
  directOnly?: boolean,
): Promise<AssistantMessage> {
  return notBuilt('src/services/compact/compact/summarise.ts:321')
}
