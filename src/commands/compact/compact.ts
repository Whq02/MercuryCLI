import { APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { getLastCacheSafeParams } from '../../services/agents/forkedAgent.js'
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
import type { Message } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../services/messages.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { fetchSystemPromptParts } from '../../services/agents/queryContext.js'
import type { CacheSafeParams } from '../../services/agents/forkedAgent.js'
import { isAbortError, errorMessage, hasExactErrorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'

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
  const tokenCounts =
    typeof pre === 'number' && pre > 0 && typeof post === 'number' && post >= 0
      ? {
          tokensBefore: pre,
          tokensAfter: post,
          contextReclaimedPct: Math.round(Math.min(100, Math.max(0, ((pre - post) / pre) * 100))),
        }
      : {}

  for (const summary of result.summaryMessages) {
    if (!summary.isCompactSummary) continue
    delete summary.isVisibleInTranscriptOnly
    const existing = summary.summarizeMetadata
    summary.summarizeMetadata = {
      ...existing,
      messagesSummarized: existing?.messagesSummarized ?? computedCount,
      ...(customInstructions ? { userContext: existing?.userContext ?? customInstructions } : {}),
      ...tokenCounts,
      ...(kept > 0 ? { keptMessages: kept } : {}),
    }
  }
}

async function resolveCacheSafeParams(
  context: LocalJSXCommandContext,
  messages: Message[],
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

export async function call(
  args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  const customInstructions = args.trim()
  const messages = getMessagesAfterCompactBoundary(context.messages)
  if (messages.length === 0) {
    throw new Error(NO_MESSAGES_TO_COMPACT)
  }

  const model = context.options.engineModel
  const estTokens = tokenCountWithEstimation(messages, model)
  await awaitContextWindowSource(model, { estTokens })
  const threshold = getAutoCompactThreshold(model)

  const cacheSafeParams = await resolveCacheSafeParams(context, messages)
  const refold = isRefold(messages)
  const projection = await projectManualFold(messages, context, cacheSafeParams, threshold)
  if (projection !== null && manualFoldHasNothingToFold(projection)) {
    throw new Error(nothingToCompactLine(projection.context, nothingToCompactReason(projection, refold)))
  }
  const restoreFiles = projection?.restoreFiles ?? true

  const foldChoice = foldModelFor(messages, model, { forced: false })
  if (foldChoice.source === 'history') {
    logForDebugging(
      `compact: the summary is written by ${foldChoice.model} — the seated ${model}'s window does not hold the history (about ${foldChoice.count} tokens by Mercury's count)`,
    )
  }

  const useSessionMemory = customInstructions === '' && shouldUseSessionMemoryCompaction()

  let compactionResult: CompactionResult
  try {
    compactionResult = await withFoldStatus(
      context,
      async scoped => {
        const scopedParams: CacheSafeParams = {
          ...cacheSafeParams,
          toolUseContext: scoped,
        }
        if (useSessionMemory) {
          scoped.onCompactProgress?.({ type: 'stage', stage: 'session-memory' })
          const smResult = await trySessionMemoryCompaction(
            messages,
            scoped.agentId,
            threshold,
            scoped,
            'manual',
          )
          if (smResult !== null) return smResult
        }
        return await compactConversation(
          messages,
          scoped,
          scopedParams,
          false,
          customInstructions || undefined,
          false,
          {
            isRecompaction: refold,
            turnsSincePreviousCompact: -1,
            autoCompactThreshold: threshold,
            restoreFiles,
            mustShrink: true,
          },
          undefined,
          foldChoice.model,
        )
      },
      {
        trigger: 'manual',
        sessionMemory: useSessionMemory,
        microcompaction: false,
      },
    )
  } catch (err) {
    if (
      context.abortController.signal.aborted ||
      err instanceof APIUserAbortError ||
      isAbortError(err) ||
      hasExactErrorMessage(err, ERROR_MESSAGE_USER_ABORT)
    ) {
      throw new Error(ERROR_MESSAGE_USER_ABORT)
    }
    if (
      (err instanceof Error && isNothingToCompactMessage(err.message)) ||
      hasExactErrorMessage(err, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    ) {
      throw err
    }
    if (
      !hasExactErrorMessage(err, ERROR_MESSAGE_INCOMPLETE_RESPONSE) &&
      !hasExactErrorMessage(err, ERROR_MESSAGE_FOLD_TIMEOUT)
    ) {
      logError(err)
    }
    throw new Error(`Error during compaction: ${errorMessage(err)}`)
  }

  setLastSummarizedMessageId(undefined)
  suppressCompactWarning()
  runPostCompactCleanup(
    { querySource: context.options.querySource, agentId: context.agentId },
    buildPostCompactMessages(compactionResult),
  )

  if (shouldEnrichForLiveDisplay(context)) {
    enrichSummaryForLiveDisplay(compactionResult, messages.length, customInstructions)
  }

  const displayText = manualCompactDisplayText(context, compactionResult, messages.length)
  return {
    type: 'compact',
    compactionResult,
    displayText,
  }
}
