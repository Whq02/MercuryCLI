import type { ToolUseContext } from '../../Tool.js'
import type { NonNullableUsage } from '../api/emptyUsage.js'
import type { Message, UserMessage, CompactMetadata } from '../../types/message.js'
import '../../bootstrap/state.js'
import '../../utils/format.js'
import '../../utils/attachments/agentRoster.js'
import '../../utils/attachments/deltas.js'
import '../../utils/attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import '../../utils/attachments/userContext.js'
import '../../utils/config/derived.js'
import '../../utils/cockpit/turnReceipt.js'
import '../../utils/cockpit/awaySummary.js'
import '../../utils/permissions/filesystem.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import '../../utils/forkedAgent.js'
import '../../utils/api.js'
import '../../utils/systemPromptType.js'
import '../../utils/messageQueueManager.js'
import '../providers/routeLaw.js'
import '../../utils/hooks/fire.js'
import '../../utils/hooks/contextBound.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { logError } from '../../utils/log.js'
import '../../utils/memory/types.js'
import { createCompactBoundaryMessage, createUserMessage } from '../../utils/messages.js'
import { expandPath } from '../../utils/path.js'
import '../../utils/sessionActivity.js'
import { reAppendSessionMetadata } from '../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { recordContentReplacement } from '../../utils/sessionStorage/writer.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import '../../utils/sleep.js'
import '../api/errors.js'
import '../api/overflowSignal.js'
import '../providers/local/localCatalogue.js'
import '../providers/callModelRouter.js'
import '../providers/streamIdleBudget.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import '../api/dumpPrompts.js'
import '../api/withRetry.js'
import { APIUserAbortError } from '../api/sdkErrors.js'
import '../../services/instructions/engine.js'
import { releaseLspDocumentsForContext } from '../lsp/manager.js'
import { advanceContextEpoch, getContextEpoch } from '../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger } from './foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../run/runContinuationCapsule.js'
import '../tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../run/requestGauge.js'
import { getTurnReserveTokens } from './autoCompact.js'
import '../../utils/toolResultStorage.js'
import '../../tools/FileReadTool/FileReadTool.js'
import '../../constants/toolLimits.js'
import '../../tools/FileReadTool/prompt.js'
import '../../tools/ToolSearchTool/ToolSearchTool.js'
import './grouping.js'
import { estimateContextTokens } from './microCompact.js'
import './checkpointRewind.js'
import { getCompactPrompt, getCompactUserSummaryMessage, renderFoldedWork } from './prompt.js'
import { computeVerbatimRecentTail, DEFAULT_KEEP_ROUNDS, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryCompactKeepTailEnabled, withFoldedResults } from './verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from './operatorMessages.js'
import { prepareFoldContext } from './foldTransaction.js'
import { renderFoldMemory, retireFoldToMemory } from './foldRetirement.js'
import { carryFoldPrefix } from './cacheEpoch.js'
import '../providers/toolEconomy.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../../utils/messages/apiFilters.js'
import '../../utils/messages/imageRequestFit.js'
import './foldStatus.js'
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, DEGRADED_SUMMARY_LENGTH } from './compact/limits.js'
import { type CompactionResult, type RecompactionInfo, foldDefersNow, buildPostCompactMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './compact/result.js'
import { mergeHookInstructions } from './compact/input.js'
import { collectPreservedReadPaths, obligationsOverThresholdMessage, snapshotAndClearReadState, assembleAttachments } from './compact/attachments.js'
import { compactionBeforeHooks, compactionAfterHooks } from './compact/hooks.js'
import { notifyCompactionError, restoreAfterCompaction, withEngineModel } from './compact/status.js'
import { summariseForFold } from './compact/foldSummary.js'
import { chooseFoldTail } from './compact/foldTail.js'
import { landFold } from './compact/foldLanding.js'

export { POST_COMPACT_MAX_FILES_TO_RESTORE, POST_COMPACT_TOKEN_BUDGET, POST_COMPACT_MAX_TOKENS_PER_FILE, POST_COMPACT_MAX_TOKENS_PER_SKILL, POST_COMPACT_SKILLS_TOKEN_BUDGET, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, NOTHING_TO_COMPACT_KEY, nothingToCompactLine, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, ERROR_MESSAGE_PROMPT_TOO_LONG, ERROR_MESSAGE_USER_ABORT, ERROR_MESSAGE_INCOMPLETE_RESPONSE, ERROR_MESSAGE_NO_SUMMARY, PROSE_SKIPPED_KEY, MODEL_REFUSAL_STOP_KEY } from './compact/limits.js'
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
export { isRefold, manualFoldHasNothingToFold, projectManualFold } from './compact/projection.js'
export type { ManualFoldProjection } from './compact/projection.js'
export { partialCompactConversation } from './compact/partial.js'

void notifyCompaction

export { compactionAfterHooks }

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
  overflow?: OverflowSignal,
  summaryModel?: string,
): Promise<CompactionResult> {
  const transaction = prepareFoldContext(context)
  context = transaction.context
  let ceiling = recompactionInfo?.autoCompactThreshold
  let landing: number | undefined
  const summaryContext = summaryModel === undefined ? context : withEngineModel(context, summaryModel)
  const summaryCacheSafeParams =
    summaryModel === undefined
      ? cacheSafeParams
      : { ...cacheSafeParams, toolUseContext: withEngineModel(cacheSafeParams.toolUseContext, summaryModel) }
  const trigger = isAutoCompact ? 'auto' : 'manual'
  const boundaryTrigger: CompactMetadata['trigger'] = overflow !== undefined ? 'overflow' : trigger
  const newestMessageFollows = (cacheSafeParams.postFoldCarry ?? []).some(row => operatorTextOf(row) !== null)
  try {
    if (messages.length === 0) throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    const preCompactTokenCount = tokenCountWithEstimation(messages)

    context.setSDKStatus?.('compacting')
    const before = await compactionBeforeHooks(context, { trigger: boundaryTrigger, ...(customInstructions !== undefined ? { instructions: customInstructions } : {}), tokens: preCompactTokenCount })
    const beforeRows: Message[] = hookRowsOfResult(before).map(row => createAttachmentMessage(row))
    const mergedInstructions = mergeHookInstructions(customInstructions, before.answer.instructions)

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })
    const owner = ownerFromToolUseContext(context)
    const capsuleProbe = buildRunContinuationCapsule(owner)
    const ledger = buildFoldLedger(messages, owner, getContextEpoch(owner).epoch + 1)
    const gauge = readRequestGauge(messages, context.options.engineModel)
    landing = ceiling === undefined ? undefined : foldLandingCeiling(ceiling, messages, gauge?.density.ratio ?? 1, gauge?.density.residuals, getTurnReserveTokens(context.options.engineModel))
    const landingCount = (rows: Message[]): number => {
      const request = [...rows, ...(cacheSafeParams.postFoldCarry ?? [])]
      return gauge ? estimateRequestGauge(request, gauge.fixed, gauge.density, context.options.engineModel) : estimateContextTokens(request, context.options.engineModel)
    }
    if (ceiling !== undefined) {
      const obligations = selectOperatorMessages(messages)
      const estimate = landingCount([
        createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount),
        ...(obligations ? [createAttachmentMessage(obligations)] : []),
        createUserMessage({ content: renderFoldLedger(ledger), isCompactSummary: true }),
        ...beforeRows,
      ])
      if (estimate >= ceiling) throw new Error(obligationsOverThresholdMessage(estimate, ceiling))
    }
    const promptText = getCompactPrompt(mergedInstructions, { runCapsulePresent: capsuleProbe !== null })
    const allFolded = (keep: Message[]): Message[] => withFoldedResults(keep, new Map(foldableResults(keep).map(result => [result.toolUseId, foldedResultPlaceholder(result)])))
    const fitsUnder = (limit: number | undefined, resultsFolded: boolean, prose: string, memoryNote: string | null) => (keep: Message[]): boolean => {
      if (limit === undefined) return true
      const operator = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
      const marker = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount)
      const work = renderFoldedWork(foldedWorkOf(messages, keep, marker.uuid))
      const capsule = buildRunContinuationCapsule(owner, [...context.readFileState.keys()])
      const text = getCompactUserSummaryMessage([prose, capsule, work, memoryNote].filter(part => part !== null).join('\n\n'), suppressFollowUpQuestions, getTranscriptPath(), true, newestMessageFollows) + `\n\n${renderFoldLedger(ledger)}`
      return landingCount([marker, ...(operator ? [createAttachmentMessage(operator)] : []), createUserMessage({ content: text, isCompactSummary: true }), ...stripThinkingFromIndex(resultsFolded ? allFolded(keep) : keep, 0), ...beforeRows]) < limit
    }
    const { splitRounds, response, rawSummary, proseSkipped, proseSkippedReceipt } = await summariseForFold({ messages, context, summaryContext, summaryCacheSafeParams, promptText, gauge, overflow, preCompactTokenCount, landing, ceiling, fitsUnder })
    const prose = proseSkipped ?? rawSummary
    if (overflow?.source === 'provider' && overflow.limitTokens !== undefined) {
      ceiling = Math.min(ceiling ?? Infinity, overflow.limitTokens)
      landing = Math.min(landing ?? Infinity, foldLandingCeiling(ceiling, messages, gauge?.density.ratio ?? 1, gauge?.density.residuals, getTurnReserveTokens(context.options.engineModel)))
    }
    context.onCompactProgress?.({ type: 'stage', stage: 'restoring' })
    const memory = retireFoldToMemory({
      messages, owner, epoch: ledger.epoch, records: ledger.sourceRecordIds.length,
      aborted: context.abortController.signal.aborted,
      ...(context.agentId === undefined ? {} : { agent: String(context.agentId) }),
    })
    const memoryText = renderFoldMemory(memory)

    const selectTail = (opts: Parameters<typeof computeVerbatimRecentTail>[1]): ReturnType<typeof computeVerbatimRecentTail> => {
      try {
        return computeVerbatimRecentTail(messages, { ...opts, minRounds: splitRounds })
      } catch (error) {
        throw new Error(`${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let { messagesToKeep, tailPrecedingUuid, recentRounds, foldTarget } = chooseFoldTail({ selectTail, fitsUnder, prose, memoryText, landing, ceiling })
    const operatorSelection = selectOperatorMessages(messages, {
      keptUuids: new Set((messagesToKeep ?? []).map(message => message.uuid)),
    })
    const operatorMessages = operatorSelection === null ? undefined : createAttachmentMessage(operatorSelection)
    if (operatorSelection !== null) {
      logForDebugging(`compact: operator messages block carries ${operatorSelection.messages.length} of ${operatorSelection.messages.length + operatorSelection.omitted} prompts verbatim`)
    }

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    const postCompactFileAttachments = await assembleAttachments(snapshot, context, messagesToKeep ?? [], 'compact_full', ledgerBeforeFold)

    const lastMessage = messages[messages.length - 1] as Message
    const anchor = messagesToKeep !== undefined ? tailPrecedingUuid : lastMessage.uuid
    const boundary = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount, anchor)
    boundary.compactMetadata.ledger = ledger
    boundary.compactMetadata.memory = memory
    if (gauge) boundary.compactMetadata.requestGauge = { key: gauge.key, epoch: getContextEpoch(owner).epoch + 1, fixed: gauge.fixed, density: gauge.density }
    boundary.compactMetadata.recentRounds = recentRounds ?? { requested: DEFAULT_KEEP_ROUNDS, kept: 0, tokens: 0, reason: isMercuryCompactKeepTailEnabled() ? 'no-complete-tail' : 'disabled' }
    if (overflow !== undefined) boundary.compactMetadata.overflow = overflow
    const discovered = extractDiscoveredToolNames(messages)
    if (discovered.size > 0) boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()

    const capsule = buildRunContinuationCapsule(owner, Object.keys(snapshot))
    const degraded = proseSkipped !== undefined || rawSummary.trim().length < DEGRADED_SUMMARY_LENGTH
    const foldedWork = renderFoldedWork(foldedWorkOf(messages, messagesToKeep ?? [], boundary.uuid))
    const summaryWithCapsule = [prose, capsule, foldedWork, memoryText].filter((part): part is string => part !== null).join('\n\n')

    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(
          summaryWithCapsule,
          suppressFollowUpQuestions,
          getTranscriptPath(),
           !!messagesToKeep,
          newestMessageFollows,
        ) + `\n\n${renderFoldLedger(ledger)}`,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]
    if (messagesToKeep !== undefined) {
      annotateBoundaryWithPreservedSegment(boundary, summaryMessages.at(-1)!.uuid, messagesToKeep)
    }
    annotateBoundaryWithWork(boundary, messages, messagesToKeep ?? [], summaryMessages.at(-1)!.uuid)

    const usage = response === undefined ? undefined : (response.message as { usage?: NonNullableUsage }).usage
    const callUsageTotal = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      : 0
    let partial: CompactionResult = {
      boundaryMarker: boundary,
      operatorMessages,
      summaryMessages,
      messagesToKeep,
      attachments: postCompactFileAttachments,
      hookResults: beforeRows,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
      ...(proseSkippedReceipt !== undefined ? { notes: [proseSkippedReceipt] } : {}),
    }
    const cacheEpoch = carryFoldPrefix(messages, buildPostCompactMessages(partial), String(rosterOwnerFromToolUseContext(context)), context.options.engineModel, usage, discovered, foldDefersNow(context))
    boundary.compactMetadata.cacheEpoch = cacheEpoch.receipt
    if (cacheEpoch.attachment) partial.attachments.push(cacheEpoch.attachment)
    const landed = landFold(partial, messagesToKeep, recentRounds, { messages, boundary, ledger, prose, capsule, memoryText, suppressFollowUpQuestions, newestMessageFollows, landing, ceiling, foldTarget, splitRounds, selectTail, landingCount })
    partial = landed.partial
    messagesToKeep = landed.messagesToKeep
    const { truePostCompactTokenCount, folded } = landed
    const visibleReads = collectPreservedReadPaths(messagesToKeep ?? [])
    for (const row of partial.attachments) if (row.attachment.type === 'file') visibleReads.add(expandPath(row.attachment.filename))
    for (const path of context.readFileState.keys()) if (!visibleReads.has(expandPath(path))) context.readFileState.delete(path)
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    boundary.compactMetadata.postTokens = truePostCompactTokenCount
    const afterRows = await compactionAfterHooks(context, { method: 'summary', trigger: boundaryTrigger, tokensBefore: preCompactTokenCount, tokensAfter: truePostCompactTokenCount, summary: prose })
    partial = { ...partial, hookResults: [...beforeRows, ...afterRows] }
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    await releaseLspDocumentsForContext('compact_full')
    transaction.commit(folded)
    if (folded.size > 0 && (recompactionInfo?.querySource === 'sdk' || recompactionInfo?.querySource?.startsWith('agent:') === true || recompactionInfo?.querySource?.startsWith('main_thread') === true)) {
      await recordContentReplacement([...folded].map(([toolUseId, replacement]) => ({ kind: 'tool-result' as const, toolUseId, replacement })), context.agentId).catch((error: unknown) => logError(error))
    }
    restoreBoundPrefixFromMessages(buildPostCompactMessages(partial), { rosterOnly: context.agentId !== undefined, fold: true })
    advanceContextEpoch(owner, {
      kind: isAutoCompact ? 'auto-compact' : 'manual-compact',
      reason: isAutoCompact ? 'auto-compact threshold' : 'operator /compact',
      tokensBefore: preCompactTokenCount,
      tokensAfter: truePostCompactTokenCount,
      preservedTailCount: messagesToKeep !== undefined ? messagesToKeep.length : null,
      capsule: degraded
        ? { state: 'degraded', reason: proseSkippedReceipt ?? `semantic summary under ${DEGRADED_SUMMARY_LENGTH} chars` }
        : capsule !== null
          ? { state: 'installed', reason: 'summary + capsule' }
          : { state: 'none', reason: 'no substantive run' },
    })

    if (context.agentId === undefined) reAppendSessionMetadata()

    return {
      ...partial,
      truePostCompactTokenCount,
    }
  } catch (err) {
    if (!isAutoCompact) notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}
