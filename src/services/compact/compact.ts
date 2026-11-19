import type { ToolUseContext } from '../../Tool.js'
import type { NonNullableUsage } from '../api/emptyUsage.js'
import type { AssistantMessage, Message, UserMessage, CompactMetadata } from '../../types/message.js'
import type { UUID } from 'node:crypto'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { logError } from '../../utils/log.js'
import { createCompactBoundaryMessage, createUserMessage } from '../../utils/messages.js'
import { expandPath } from '../../utils/path.js'
import { reAppendSessionMetadata } from '../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { recordContentReplacement } from '../../utils/sessionStorage/writer.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { APIUserAbortError } from '../api/sdkErrors.js'
import { releaseLspDocumentsForContext } from '../lsp/manager.js'
import { advanceContextEpoch, getContextEpoch } from '../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger } from './foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../run/runContinuationCapsule.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../run/requestGauge.js'
import { getTurnReserveTokens } from './autoCompact.js'
import { estimateContextTokens } from './microCompact.js'
import { getCompactPrompt, getCompactUserSummaryMessage, renderFoldedWork } from './prompt.js'
import { computeVerbatimRecentTail, DEFAULT_KEEP_ROUNDS, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryCompactKeepTailEnabled, withFoldedResults } from './verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from './operatorMessages.js'
import { prepareFoldContext } from './foldTransaction.js'
import { renderFoldMemory, retireFoldToMemory } from './foldRetirement.js'
import { carryFoldPrefix } from './cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../../utils/messages/apiFilters.js'
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, SPLIT_STAND_IN_FLOOR_TOKENS, SPLIT_STAND_IN_LANDING_SHARE, DEGRADED_SUMMARY_LENGTH } from './compact/limits.js'
import { type CompactionResult, type RecompactionInfo, foldDefersNow, buildPostCompactMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './compact/result.js'
import { mergeHookInstructions } from './compact/input.js'
import { collectPreservedReadPaths, fitPostCompactUnderThreshold, obligationsOverThresholdMessage, postCompactOverThresholdMessage, snapshotAndClearReadState, assembleAttachments } from './compact/attachments.js'
import { validateSummary } from './compact/summaryCheck.js'
import { newFoldLadder, foldLadderExhausted, proseSkippedNote, proseSkippedLine, summarizeWithPtlRetry } from './compact/ladder.js'
import { compactionBeforeHooks, compactionAfterHooks } from './compact/hooks.js'
import { notifyCompactionError, restoreAfterCompaction, withEngineModel } from './compact/status.js'
import { summariserFitFor, prefitSummariserInput } from './compact/summariserFit.js'

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
    const fit = await summariserFitFor(summaryContext, summaryCacheSafeParams, promptText, gauge)
    const ladder = newFoldLadder(fit.budgetTokens)
    let splitRounds = 0
    let response: AssistantMessage | undefined
    let rawSummary = ''
    let proseSkipped: string | undefined
    let proseSkippedReceipt: string | undefined
    try {
      let summaryInput = messages
      const requestTokens = estimateRequestGauge(messages, { digest: '', tokens: 0 }, { ratio: fit.ratio, samples: 0, residuals: [] }, summaryContext.options.engineModel)
      if (overflow !== undefined || preCompactTokenCount + fit.promptTokens > fit.blockingLimit || requestTokens > fit.limitTokens) {
        let split: { retiring: Message[]; rounds: number } | null = null
        if (isMercuryCompactKeepTailEnabled()) {
          const standIn = 'summary '.repeat(Math.ceil(Math.min(fit.reserveTokens, Math.max(SPLIT_STAND_IN_FLOOR_TOKENS, Math.floor((landing ?? fit.reserveTokens) / SPLIT_STAND_IN_LANDING_SHARE))) / 2))
          for (const [limit, resultsFolded] of [[landing, false], [ceiling, false], [landing, true], [ceiling, true]] as const) {
            try {
              const tail = computeVerbatimRecentTail(messages, { fits: fitsUnder(limit, resultsFolded, standIn, null) })
              const first = tail === null || tail.keep.length === 0 ? -1 : messages.findIndex(row => row.uuid === tail.keep[0]?.uuid)
              if (tail !== null && first > 0) split = { retiring: messages.slice(0, first), rounds: tail.roundsKept }
              break
            } catch {
              split = null
            }
          }
        }
        const shaped = await prefitSummariserInput(messages, fit, split, summaryCacheSafeParams, promptText, summaryContext, ladder)
        summaryInput = shaped.input
        if (shaped.shaped && split !== null) splitRounds = split.rounds
      }
      response = await summarizeWithPtlRetry(summaryInput, summaryCacheSafeParams, promptText, summaryContext, ladder)
      rawSummary = validateSummary(response, true)
    } catch (error) {
      if (!foldLadderExhausted(error) || context.abortController.signal.aborted) throw error
      proseSkipped = proseSkippedLine((error as Error).message)
      proseSkippedReceipt = proseSkippedNote((error as Error).message)
      logForDebugging(`compact: the ladder's bottom — ${(error as Error).message}; the fold lands on Mercury's own records without a prose summary`, { level: 'warn' })
    }
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

    let messagesToKeep: Message[] | undefined
    let tailPrecedingUuid: UUID | undefined
    let recentRounds: CompactMetadata['recentRounds']
    let foldTarget: number | undefined
    const selectTail = (opts: Parameters<typeof computeVerbatimRecentTail>[1]): ReturnType<typeof computeVerbatimRecentTail> => {
      try {
        return computeVerbatimRecentTail(messages, { ...opts, minRounds: splitRounds })
      } catch (error) {
        throw new Error(`${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (isMercuryCompactKeepTailEnabled()) {
      const fits = (limit: number | undefined, resultsFolded = false) => fitsUnder(limit, resultsFolded, prose, memoryText)
      let tail: ReturnType<typeof computeVerbatimRecentTail>
      try {
        tail = selectTail({ fits: fits(landing) })
      } catch (error) {
        if (landing === undefined) throw error
        try {
          tail = selectTail({ fits: fits(ceiling) })
        } catch {
          try {
            tail = selectTail({ fits: fits(landing, true) })
            foldTarget = landing
          } catch {
            tail = selectTail({ fits: fits(ceiling, true) })
            foldTarget = ceiling
          }
        }
      }
      if (tail !== null && tail.keep.length > 0) {
        messagesToKeep = stripThinkingFromIndex(tail.keep, 0)
        tailPrecedingUuid = tail.precedingUuid
        recentRounds = { requested: tail.roundsRequested, kept: tail.roundsKept, tokens: tail.estimatedTokens, reason: tail.reason }
        logForDebugging(`compact: verbatim tail keeps ${tail.roundsKept} rounds (${tail.keep.length} messages)`)
      }
    }
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
    let truePostCompactTokenCount = landingCount(buildPostCompactMessages(partial))
    const room = landing ?? ceiling
    if (room !== undefined && truePostCompactTokenCount >= room) {
      const fit = fitPostCompactUnderThreshold(partial, room, landingCount)
      if (fit.shed.length > 0) {
        logForDebugging(
          `compact: post-compact estimate ${truePostCompactTokenCount} >= the landing line ${room} (threshold ${ceiling}); shed ${fit.shed.join(', ')} → ${fit.estimate}`,
        )
      }
      partial = fit.result
      truePostCompactTokenCount = fit.estimate
    }

    const completeFit = room === undefined ? { result: partial, estimate: landingCount(buildPostCompactMessages(partial)) } : fitPostCompactUnderThreshold(partial, room, landingCount)
    partial = completeFit.result
    truePostCompactTokenCount = completeFit.estimate
    const folded = new Map<string, string>()
    const rekeep = (keep: Message[], rounds: NonNullable<CompactMetadata['recentRounds']>): void => {
      messagesToKeep = keep
      recentRounds = rounds
      boundary.compactMetadata.recentRounds = rounds
      const selection = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
      const work = renderFoldedWork(foldedWorkOf(messages, keep, boundary.uuid))
      const summaryText = getCompactUserSummaryMessage([prose, capsule, work, memoryText].filter(part => part !== null).join('\n\n'), suppressFollowUpQuestions, getTranscriptPath(), true, newestMessageFollows) + `\n\n${renderFoldLedger(ledger)}`
      partial = { ...partial, messagesToKeep: keep, operatorMessages: selection ? createAttachmentMessage(selection) : undefined, summaryMessages: partial.summaryMessages.map((row, index) => index === 0 ? { ...row, message: { ...row.message, content: summaryText } } : row) }
      annotateBoundaryWithPreservedSegment(boundary, partial.summaryMessages.at(-1)!.uuid, keep)
      annotateBoundaryWithWork(boundary, messages, keep, partial.summaryMessages.at(-1)!.uuid)
      const fitted = fitPostCompactUnderThreshold(partial, room ?? Infinity, landingCount)
      partial = fitted.result
      truePostCompactTokenCount = fitted.estimate
    }
    const widest = { partial, messagesToKeep, recentRounds, logicalParentUuid: boundary.logicalParentUuid, estimate: truePostCompactTokenCount }
    while (room !== undefined && foldTarget === undefined && truePostCompactTokenCount >= room && recentRounds !== undefined && recentRounds.kept > Math.max(1, splitRounds)) {
      const narrower = selectTail({ keepRounds: recentRounds.kept - 1 })
      if (narrower === null) break
      boundary.logicalParentUuid = narrower.precedingUuid
      rekeep(stripThinkingFromIndex(narrower.keep, 0), { requested: recentRounds.requested, kept: narrower.roundsKept, tokens: narrower.estimatedTokens, reason: 'request-budget' })
    }
    if (room !== undefined && messagesToKeep !== undefined && recentRounds !== undefined) {
      const whole = messagesToKeep
      const target = foldTarget ?? room
      for (const result of foldableResults(whole)) {
        if (truePostCompactTokenCount < target) break
        folded.set(result.toolUseId, foldedResultPlaceholder(result))
        const keep = withFoldedResults(whole, folded)
        rekeep(keep, { ...recentRounds, tokens: roughTokenCountEstimationForMessages(keep), folded: folded.size })
      }
    }
    if (landing !== undefined && truePostCompactTokenCount >= landing && recentRounds !== undefined) {
      if (widest.recentRounds !== undefined && widest.estimate < (ceiling ?? Infinity)) {
        folded.clear()
        partial = widest.partial
        messagesToKeep = widest.messagesToKeep
        truePostCompactTokenCount = widest.estimate
        boundary.logicalParentUuid = widest.logicalParentUuid
        recentRounds = widest.recentRounds
        annotateBoundaryWithPreservedSegment(boundary, partial.summaryMessages.at(-1)!.uuid, messagesToKeep ?? [])
        annotateBoundaryWithWork(boundary, messages, messagesToKeep ?? [], partial.summaryMessages.at(-1)!.uuid)
      }
      recentRounds = { ...recentRounds, reason: 'no-room' }
      boundary.compactMetadata.recentRounds = recentRounds
    }
    if (ceiling !== undefined && truePostCompactTokenCount >= ceiling) throw new Error(postCompactOverThresholdMessage(truePostCompactTokenCount, ceiling))
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
