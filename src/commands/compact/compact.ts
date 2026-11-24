import { APIUserAbortError } from '../../engine/request-parts/sdkErrors.js'
import { getLastCacheSafeParams } from '../../crew/agents/forkedAgent.js'
import {
  foldConversation,
  buildPostFoldMessages,
  ERROR_MESSAGE_FOLD_TIMEOUT,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  type FoldResult,
  isNothingToFoldMessage,
  isRefold,
  manualFoldHasNothingToFold,
  NO_MESSAGES_TO_FOLD,
  nothingToFoldLine,
  nothingToFoldReason,
  projectManualFold,
  withFoldStatus,
  ERROR_MESSAGE_USER_ABORT,
} from '../../engine/compaction/foldConversation.js'
import { manualFoldDisplayText, shouldEnrichForLiveDisplay } from '../../engine/compaction/manualReceipt.js'
import { foldModelFor, getAutoFoldThreshold } from '../../engine/compaction/autoFold.js'
import { awaitContextWindowSource } from '../../engine/context-window/contextWindowWarmup.js'
import { tokenCountWithEstimation } from '../../engine/context-window/contextTokenCount.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { suppressFoldWarning } from '../../engine/compaction/foldWarningSuppression.js'
import { runPostFoldCleanup } from '../../engine/compaction/postFoldCleanup.js'
import { shouldUseSessionNotesFold, trySessionNotesFold } from '../../engine/compaction/sessionNotesFold.js'
import { setLastSummarizedMessageId } from '../../sessions/session-memory/extractionState.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../catalogue/command.js'
import type { Message, UserMessage } from '../../engine/message-shapes/message.js'
import { getMessagesAfterFoldBoundary } from '../../engine/messages/messages.js'
import { buildEffectiveSystemPrompt } from '../../engine/system-prompt/systemPrompt.js'
import { fetchSystemPromptParts } from '../../engine/system-prompt/systemPromptParts.js'
import type { CacheSafeParams } from '../../crew/agents/forkedAgent.js'
import { isAbortError, errorMessage, hasExactErrorMessage } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import { getUserContext } from '../../engine/requestContext.js'

export { NOTHING_TO_FOLD_KEY, nothingToFoldLine } from '../../engine/compaction/foldConversation.js'

function enrichSummaryForLiveDisplay(
  result: FoldResult,
  messagesHandedIn: number,
  customInstructions: string,
): void {
  const kept = result.messagesToKeep?.length ?? 0
  const computedCount = Math.max(0, messagesHandedIn - kept)

  const pre = result.preFoldTokenCount
  const post = result.truePostFoldTokenCount ?? result.postFoldTokenCount
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

async function buildFoldCacheSafeParams(
  messages: Message[],
  context: LocalJSXCommandContext,
): Promise<CacheSafeParams> {
  const cached = getLastCacheSafeParams()
  if (cached !== null) {
    return {
      ...cached,
      toolUseContext: context,
      forkContextMessages: messages,
    }
  }
  const { defaultSystemPrompt, userContext, systemContext } = await fetchSystemPromptParts({
    tools: context.options.tools,
    engineModel: context.options.engineModel,
    mcpClients: context.options.mcpClients,
    customSystemPrompt: context.options.customSystemPrompt,
    permissionMode: context.getAppState().toolPermissionContext.mode,
  })
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages: messages,
  }
}

async function callUnderFoldStatus(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  const messages = getMessagesAfterFoldBoundary(context.messages)
  if (messages.length === 0) {
    throw new Error(NO_MESSAGES_TO_FOLD)
  }
  const customInstructions = args.trim()
  try {
    if (customInstructions === '') {
      if (shouldUseSessionNotesFold()) {
        context.onFoldProgress?.({ type: 'stage', stage: 'session-memory' })
      }
      const sessionMemoryResult = await trySessionNotesFold(messages, context.agentId, undefined, context, 'manual')
      if (sessionMemoryResult !== null) {
        getUserContext.cache.clear()
        runPostFoldCleanup(undefined, buildPostFoldMessages(sessionMemoryResult))
        suppressFoldWarning()
        return {
          type: 'compact',
          foldHandoff: sessionMemoryResult,
          displayText: manualFoldDisplayText(context, sessionMemoryResult, messages.length),
        }
      }
    }

    const model = context.options.engineModel
    await awaitContextWindowSource(model, { estTokens: tokenCountWithEstimation(messages, model) })
    const cacheSafeParams = await buildFoldCacheSafeParams(messages, context)
    const refold = isRefold(messages)
    const projection = await projectManualFold(messages, context, cacheSafeParams, getAutoFoldThreshold(model))
    if (projection !== null && (refold ? manualFoldHasNothingToFold(projection) : projection.after >= projection.before)) {
      logForDebugging(
        `compact: refused before the summariser — ${projection.folds} of ${messages.length} messages would fold (${projection.workingRoundsFolded} working rounds), the fold would land at ${projection.after} tokens against ${projection.before} by the same estimate`,
      )
      throw new Error(nothingToFoldLine(projection.context, nothingToFoldReason(projection, refold)))
    }

    const foldChoice = foldModelFor(messages, model, { forced: false })
    if (foldChoice.source === 'history') {
      logForDebugging(
        `compact: the summary is written by ${foldChoice.model} — the seated ${model}'s window does not hold the history (about ${foldChoice.count} tokens by Mercury's count)`,
      )
    }

    const foldHandoff = await foldConversation(
      messages,
      context,
      cacheSafeParams,
      false,
      customInstructions || undefined,
      false,
      {
        isRefold: false,
        turnsSincePreviousFold: -1,
        autoFoldThreshold: getAutoFoldThreshold(model),
        restoreFiles: projection?.restoreFiles ?? true,
        mustShrink: true,
      },
      undefined,
      foldChoice.model,
    )

    setLastSummarizedMessageId(undefined)
    suppressFoldWarning()
    getUserContext.cache.clear()
    runPostFoldCleanup(undefined, buildPostFoldMessages(foldHandoff))
    if (shouldEnrichForLiveDisplay(context)) {
      enrichSummaryForLiveDisplay(foldHandoff, messages.length, customInstructions)
    }
    return {
      type: 'compact',
      foldHandoff,
      displayText: manualFoldDisplayText(context, foldHandoff, messages.length),
    }
  } catch (err) {
    if (context.abortController.signal.aborted || isAbortError(err)) {
      throw new APIUserAbortError({ message: ERROR_MESSAGE_USER_ABORT })
    }
    if (
      hasExactErrorMessage(err, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES) ||
      hasExactErrorMessage(err, ERROR_MESSAGE_INCOMPLETE_RESPONSE) ||
      hasExactErrorMessage(err, ERROR_MESSAGE_FOLD_TIMEOUT) ||
      (err instanceof Error && isNothingToFoldMessage(err.message))
    ) {
      throw err
    }
    logError(err)
    throw new Error(`Error during compaction: ${errorMessage(err)}`)
  }
}

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  return withFoldStatus(context, scoped => callUnderFoldStatus(args, scoped), {
    trigger: 'manual',
    sessionMemory: args.trim() === '' && shouldUseSessionNotesFold(),
    microcompaction: false,
  })
}
