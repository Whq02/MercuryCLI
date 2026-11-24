import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { NonNullableUsage } from '../request-parts/emptyUsage.js'
import type { ApiUsage } from '../message-shapes/wire.js'
import type { Message, UserMessage, FoldMetadata } from '../message-shapes/message.js'
import { createAttachmentMessage } from '../attachments/turnAttachments.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { CacheSafeParams } from '../../crew/agents/forkedAgent.js'
import { hookRowsOfResult } from '../../integrations/event-hooks/rows.js'
import { logError } from '../../platform/logs/errorLog.js'
import { createFoldBoundaryMessage, createUserMessage } from '../messages/messages.js'
import { expandPath } from '../../platform/files/path.js'
import { reAppendSessionMetadata } from '../../sessions/transcripts/sessionListings.js'
import { recordContentReplacement } from '../../sessions/transcripts/writer.js'
import { extractDiscoveredToolNames } from '../messages/toolSearch.js'
import type { OverflowSignal } from '../requests/overflowSignal.js'
import { notifyFold } from '../requests/promptCacheBreakDetection.js'
import { APIUserAbortError } from '../request-parts/sdkErrors.js'
import { releaseLspDocumentsForContext } from '../../integrations/lsp/serverManagerLifecycle.js'
import { advanceContextEpoch, getContextEpoch } from '../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger, withKeptLedgerRows } from './foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../run-owner/resolveOwner.js'
import { buildRunContinuationCapsule } from '../run/runContinuationCapsule.js'
import { getTurnReserveTokens } from '../compaction-window/autoFoldWindow.js'
import { getFoldPrompt, renderFoldedWork } from './summariserPrompt.js'
import { computeVerbatimRecentTail, DEFAULT_KEEP_ROUNDS, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryFoldKeepTailEnabled, withFoldedResults } from './verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from '../compaction-window/operatorMessages.js'
import { prepareFoldContext } from './foldTransaction.js'
import { renderFoldMemory, retireFoldToMemory, withdrawFoldMemory } from './foldRetirement.js'
import { carryFoldPrefix } from './cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../../models/roads/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../messages/apiFilters.js'
import { ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, ERROR_MESSAGE_POST_FOLD_OVER_THRESHOLD, DEGRADED_SUMMARY_LENGTH, nothingToFoldLine } from './fold/foldLimits.js'
import { type FoldResult, type RefoldInfo, foldDefersNow, buildPostFoldMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './fold/foldResult.js'
import { mergeHookInstructions } from './fold/summariserInput.js'
import { collectPreservedReadPaths, obligationsOverThresholdMessage, restoreReadState, snapshotAndClearReadState, assembleAttachments } from './fold/foldAttachments.js'
import { foldBeforeHooks, foldAfterHooks } from './fold/hooks.js'
import { notifyFoldError, restoreAfterFold, withEngineModel } from './fold/foldStatusAndRestore.js'
import { summariseForFold, type FitsUnder } from './fold/foldSummary.js'
import { chooseFoldTail } from './fold/foldTail.js'
import { landFold } from './fold/foldLanding.js'
import { composeFoldSummaryText, createFoldMeter } from './fold/foldMeasure.js'

export { POST_FOLD_MAX_FILES_TO_RESTORE, POST_FOLD_TOKEN_BUDGET, POST_FOLD_MAX_TOKENS_PER_FILE, POST_FOLD_MAX_TOKENS_PER_SKILL, POST_FOLD_SKILLS_TOKEN_BUDGET, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, NO_MESSAGES_TO_FOLD, NOTHING_TO_FOLD_KEY, isNothingToFoldMessage, nothingToFoldLine, ERROR_MESSAGE_POST_FOLD_OVER_THRESHOLD, ERROR_MESSAGE_PROMPT_TOO_LONG, ERROR_MESSAGE_USER_ABORT, ERROR_MESSAGE_INCOMPLETE_RESPONSE, ERROR_MESSAGE_NO_SUMMARY, PROSE_SKIPPED_KEY, MODEL_REFUSAL_STOP_KEY } from './fold/foldLimits.js'
export { malformedHistoryRefusalOf, foldRefusedForHistoryText, foldPausedForHistoryText, foldRemedyIsHeadless, FOLD_WINDOW_REFUSAL_KEY, foldWindowRefusalText, FoldRefusedForHistoryError } from './fold/refusals.js'
export { ERROR_MESSAGE_FOLD_TIMEOUT, setFoldBoundsForTests, foldStallMsFor, foldFirstByteAllowanceMs, shouldRideCacheSharingFork, foldFamilyOf } from './fold/foldBound.js'
export type { FoldBounds, FoldCut } from './fold/foldBound.js'
export { buildPostFoldMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './fold/foldResult.js'
export type { FoldResult, RefoldInfo } from './fold/foldResult.js'
export { boundedHookInstructions, mergeHookInstructions, isFoldCapsuleMessage, truncateHeadForPTLRetry, stripImagesFromMessages, stripReinjectedAttachments, createFoldCanUseTool } from './fold/summariserInput.js'
export { collectPreservedReadPaths, linesWithinTokenCeiling, fitFileAttachmentToTokenCeiling, createPostFoldFileAttachments, fitPostFoldUnderThreshold, createSkillAttachmentIfNeeded, createAsyncAgentAttachmentsIfNeeded, restorePreservedReads } from './fold/foldAttachments.js'
export type { PostFoldFit } from './fold/foldAttachments.js'
export { summaryAnswerFault, summaryRefusedByModel } from './fold/summaryCheck.js'
export { isPartSummaryMessage, splitTextForFold } from './fold/ladder.js'
export { withFoldStatus, withEngineModel } from './fold/foldStatusAndRestore.js'
export { estimateFixedRequestTokens } from './fold/summariserFit.js'
export { isRefold, manualFoldHasNothingToFold, nothingToFoldReason, projectManualFold } from './fold/projection.js'
export type { ManualFoldProjection } from './fold/projection.js'
export { foldSizes } from './fold/foldMeasure.js'
export { partialFoldConversation } from './fold/partialFold.js'

void notifyFold

export { foldAfterHooks }

function toFoldUsage(usage: ApiUsage | undefined): NonNullableUsage | undefined {
  if (!usage) return undefined
  return {
    input_tokens: usage.input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    server_tool_use: {
      web_fetch_requests: usage.server_tool_use?.web_fetch_requests ?? 0,
      web_search_requests: usage.server_tool_use?.web_search_requests ?? 0,
    },
    service_tier: usage.service_tier ?? null,
    cache_creation: {
      ephemeral_1h_input_tokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ephemeral_5m_input_tokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    },
    inference_geo: usage.inference_geo ?? null,
    iterations: usage.iterations ?? null,
    speed: usage.speed ?? null,
    output_tokens_details:
      usage.output_tokens_details?.thinking_tokens !== undefined
        ? { thinking_tokens: usage.output_tokens_details.thinking_tokens }
        : null,
  }
}

function shouldPersistReplacements(querySource: string | undefined): boolean {
  return (
    querySource === 'sdk' ||
    querySource?.startsWith('agent:') === true ||
    querySource?.startsWith('main_thread') === true
  )
}

function resolveCapsuleState(
  proseSkippedReceipt: string | undefined,
  rawSummary: string,
  capsule: string | null,
): { state: 'installed' | 'degraded' | 'none'; reason: string } {
  if (proseSkippedReceipt !== undefined) {
    return { state: 'degraded', reason: proseSkippedReceipt }
  }
  if (rawSummary.trim().length < DEGRADED_SUMMARY_LENGTH) {
    return { state: 'degraded', reason: `semantic summary under ${DEGRADED_SUMMARY_LENGTH} chars` }
  }
  if (capsule !== null) {
    return { state: 'installed', reason: 'summary + capsule' }
  }
  return { state: 'none', reason: 'no substantive run' }
}

function pruneReadFileState(
  context: ToolUseContext,
  result: FoldResult,
  messagesToKeep: Message[] | undefined,
): void {
  const keptReadPaths = collectPreservedReadPaths(messagesToKeep ?? [])
  for (const attachment of result.attachments) {
    if (attachment.attachment.type === 'file') {
      keptReadPaths.add(expandPath(attachment.attachment.filename))
    }
  }
  for (const path of [...context.readFileState.keys()]) {
    if (!keptReadPaths.has(expandPath(path))) {
      context.readFileState.delete(path)
    }
  }
}

function makeFitsUnder(params: {
  messages: Message[]
  boundaryTrigger: FoldMetadata['trigger']
  preCompactTokenCount: number
  capsule: string | null
  ledger: ReturnType<typeof buildFoldLedger>
  suppressFollowUpQuestions: boolean
  newestMessageFollows: boolean
  beforeHookRows: Message[]
  count: (rows: Message[]) => number
}): FitsUnder {
  const {
    messages,
    boundaryTrigger,
    preCompactTokenCount,
    capsule,
    ledger,
    suppressFollowUpQuestions,
    newestMessageFollows,
    beforeHookRows,
    count,
  } = params
  return (limit, resultsFolded, prose, memoryNote) => keep => {
    if (limit === undefined) return true
    const keptUuids = new Set(keep.map(row => row.uuid))
    const candidateOperator = selectOperatorMessages(messages, { keptUuids })
    let candidateTail = stripThinkingFromIndex(keep, 0)
    if (resultsFolded) {
      const replacements = new Map<string, string>()
      for (const item of foldableResults(candidateTail)) {
        replacements.set(item.toolUseId, foldedResultPlaceholder(item))
      }
      candidateTail = withFoldedResults(candidateTail, replacements)
    }
    const probeBoundary = createFoldBoundaryMessage(boundaryTrigger, preCompactTokenCount)
    const candidateSummary = createUserMessage({
      content: composeFoldSummaryText({
        prose,
        capsule,
        work: renderFoldedWork(foldedWorkOf(messages, candidateTail, probeBoundary.uuid)),
        memoryText: memoryNote,
        ledger,
        suppressFollowUpQuestions,
        keptTail: candidateTail.length > 0,
        newestMessageFollows,
      }),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const candidateRows: Message[] = [
      probeBoundary,
      ...(candidateOperator !== null ? [createAttachmentMessage(candidateOperator)] : []),
      candidateSummary,
      ...candidateTail,
      ...beforeHookRows,
    ]
    return count(candidateRows) < limit
  }
}

function buildBoundaryAndSummary(params: {
  messages: Message[]
  boundaryTrigger: FoldMetadata['trigger']
  preCompactTokenCount: number
  messagesToKeep: Message[] | undefined
  tailPrecedingUuid: Message['uuid'] | undefined
  recentRounds: FoldMetadata['recentRounds']
  memoryEnvelope: ReturnType<typeof retireFoldToMemory>
  memoryText: string
  gauge: ReturnType<typeof createFoldMeter>['gauge']
  overflow: OverflowSignal | undefined
  preCompactDiscoveredTools: string[]
  prose: string
  capsule: string | null
  ledger: ReturnType<typeof buildFoldLedger>
  suppressFollowUpQuestions: boolean
  newestMessageFollows: boolean
}): { boundaryMarker: ReturnType<typeof createFoldBoundaryMessage>; summaryMessage: UserMessage } {
  const {
    messages,
    boundaryTrigger,
    preCompactTokenCount,
    messagesToKeep,
    tailPrecedingUuid,
    recentRounds,
    memoryEnvelope,
    memoryText,
    gauge,
    overflow,
    preCompactDiscoveredTools,
    prose,
    capsule,
    ledger,
    suppressFollowUpQuestions,
    newestMessageFollows,
  } = params
  const anchorUuid = tailPrecedingUuid ?? messages[messages.length - 1]?.uuid
  const boundaryMarker = createFoldBoundaryMessage(
    boundaryTrigger,
    preCompactTokenCount,
    anchorUuid,
    undefined,
    messages.length - (messagesToKeep?.length ?? 0),
  )
  boundaryMarker.compactMetadata.memory = memoryEnvelope
  if (gauge !== null && gauge !== undefined) {
    boundaryMarker.compactMetadata.requestGauge = {
      key: gauge.key,
      epoch: gauge.epoch,
      fixed: gauge.fixed,
      density: gauge.density,
    }
  }
  boundaryMarker.compactMetadata.recentRounds = recentRounds ?? {
    requested: DEFAULT_KEEP_ROUNDS,
    kept: 0,
    tokens: 0,
    reason: isMercuryFoldKeepTailEnabled() ? 'no-complete-tail' : 'disabled',
  }
  if (overflow !== undefined) {
    boundaryMarker.compactMetadata.overflow = overflow
  }
  if (preCompactDiscoveredTools.length > 0) {
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = preCompactDiscoveredTools
  }

  const summaryMessage = createUserMessage({
    content: composeFoldSummaryText({
      prose,
      capsule,
      work: renderFoldedWork(foldedWorkOf(messages, messagesToKeep ?? [], boundaryMarker.uuid)),
      memoryText,
      ledger,
      suppressFollowUpQuestions,
      keptTail: (messagesToKeep?.length ?? 0) > 0,
      newestMessageFollows,
    }),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  })
  if (messagesToKeep !== undefined) {
    annotateBoundaryWithPreservedSegment(boundaryMarker, summaryMessage.uuid, messagesToKeep)
  }
  annotateBoundaryWithWork(boundaryMarker, messages, messagesToKeep ?? [], summaryMessage.uuid)
  return { boundaryMarker, summaryMessage }
}

function checkFixedObligations(params: {
  ceiling: number | undefined
  boundaryTrigger: FoldMetadata['trigger']
  preCompactTokenCount: number
  messages: Message[]
  ledger: ReturnType<typeof buildFoldLedger>
  beforeHookRows: Message[]
  count: (rows: Message[]) => number
}): void {
  const { ceiling, boundaryTrigger, preCompactTokenCount, messages, ledger, beforeHookRows, count } = params
  if (ceiling === undefined) return
  const probeBoundary = createFoldBoundaryMessage(boundaryTrigger, preCompactTokenCount)
  const probeOperator = selectOperatorMessages(messages)
  const probeLedger = createUserMessage({
    content: renderFoldLedger(ledger),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  })
  const fixedTokens = count([
    probeBoundary,
    ...(probeOperator !== null ? [createAttachmentMessage(probeOperator)] : []),
    probeLedger,
    ...beforeHookRows,
  ])
  if (fixedTokens >= ceiling) {
    throw new Error(obligationsOverThresholdMessage(fixedTokens, ceiling))
  }
}

async function persistFoldedReplacements(
  folded: ReadonlyMap<string, string>,
  querySource: string | undefined,
  agentId: ToolUseContext['agentId'],
): Promise<void> {
  if (!shouldPersistReplacements(querySource) || folded.size === 0) return
  const records = [...folded.entries()].map(([toolUseId, replacement]) => ({
    kind: 'tool-result' as const,
    toolUseId,
    replacement,
  }))
  try {
    await recordContentReplacement(records, agentId)
  } catch (error) {
    logError(error)
  }
}

async function finishCommittedFold(params: {
  context: ToolUseContext
  owner: ReturnType<typeof ownerFromToolUseContext>
  foldTx: ReturnType<typeof prepareFoldContext>
  clearWrittenMemory: () => void
  landed: ReturnType<typeof landFold>
  beforeHookRows: Message[]
  boundaryTrigger: FoldMetadata['trigger']
  isAutoFold: boolean
  preCompactTokenCount: number
  tokensAfter: number
  prose: string
  proseSkippedReceipt: string | undefined
  rawSummary: string
  capsule: string | null
  querySource: string | undefined
}): Promise<FoldResult> {
  const {
    context,
    owner,
    foldTx,
    clearWrittenMemory,
    landed,
    beforeHookRows,
    boundaryTrigger,
    isAutoFold,
    preCompactTokenCount,
    tokensAfter,
    prose,
    proseSkippedReceipt,
    rawSummary,
    capsule,
    querySource,
  } = params
  const afterHookRows = await foldAfterHooks(context, {
    method: 'summary',
    trigger: boundaryTrigger,
    tokensBefore: preCompactTokenCount,
    tokensAfter,
    summary: prose,
  })
  const hookResults: Message[] = [...beforeHookRows, ...afterHookRows]
  if (context.abortController.signal.aborted) {
    throw new APIUserAbortError()
  }

  await releaseLspDocumentsForContext('compact_full')
  foldTx.commit(landed.folded)
  clearWrittenMemory()

  await persistFoldedReplacements(landed.folded, querySource, context.agentId)

  const finalResult: FoldResult = {
    ...landed.partial,
    hookResults,
    truePostCompactTokenCount: tokensAfter,
  }
  restoreBoundPrefixFromMessages(buildPostFoldMessages(finalResult), { fold: true })

  advanceContextEpoch(owner, {
    kind: isAutoFold ? 'auto-compact' : 'manual-compact',
    reason: isAutoFold ? 'auto-compact threshold' : 'operator /compact',
    tokensBefore: preCompactTokenCount,
    tokensAfter,
    preservedTailCount: landed.messagesToKeep?.length ?? 0,
    capsule: resolveCapsuleState(proseSkippedReceipt, rawSummary, capsule),
  })

  if (context.agentId === undefined) {
    reAppendSessionMetadata()
  }
  return finalResult
}

export async function foldConversation(
  messages: Message[],
  incomingContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoFold = false,
  refoldInfo?: RefoldInfo,
  overflow?: OverflowSignal,
  summaryModel?: string,
): Promise<FoldResult> {
  const foldTx = prepareFoldContext(incomingContext)
  const context = foldTx.context
  const summaryContext = summaryModel !== undefined ? withEngineModel(context, summaryModel) : context
  const summaryCacheSafeParams: CacheSafeParams =
    summaryModel !== undefined
      ? { ...cacheSafeParams, toolUseContext: withEngineModel(cacheSafeParams.toolUseContext, summaryModel) }
      : cacheSafeParams
  let writtenMemoryId: string | undefined

  try {
    if (messages.length === 0) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    }

    const trigger: 'auto' | 'manual' = isAutoFold ? 'auto' : 'manual'
    const boundaryTrigger: FoldMetadata['trigger'] = overflow !== undefined ? 'overflow' : trigger

    const meter = createFoldMeter(messages, context.options.engineModel, cacheSafeParams.postFoldCarry)
    const preCompactTokenCount = meter.context
    const gauge = meter.gauge

    context.setSDKStatus?.('compacting')
    const beforeHooks = await foldBeforeHooks(context, {
      trigger: boundaryTrigger,
      ...(customInstructions !== undefined ? { instructions: customInstructions } : {}),
      tokens: preCompactTokenCount,
    })
    const beforeHookRows: Message[] = hookRowsOfResult(beforeHooks).map(row => createAttachmentMessage(row))
    const effectiveInstructions = mergeHookInstructions(customInstructions, beforeHooks.answer.instructions)
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    const owner = ownerFromToolUseContext(context)
    const rosterOwner = rosterOwnerFromToolUseContext(context)
    const nextEpoch = getContextEpoch(owner).epoch + 1
    const capsule = buildRunContinuationCapsule(owner)
    const ledger = buildFoldLedger(messages, owner, nextEpoch)

    const turnReserve = getTurnReserveTokens(context.options.engineModel)
    let ceiling = refoldInfo?.autoCompactThreshold
    let landing =
      ceiling !== undefined
        ? foldLandingCeiling(ceiling, messages, gauge?.density.ratio, gauge?.density.residuals, turnReserve)
        : undefined

    checkFixedObligations({
      ceiling,
      boundaryTrigger,
      preCompactTokenCount,
      messages,
      ledger,
      beforeHookRows,
      count: meter.count,
    })

    const newestMessageFollows = (cacheSafeParams.postFoldCarry ?? []).some((row: Message) => operatorTextOf(row) !== null)
    const fitsUnder = makeFitsUnder({
      messages,
      boundaryTrigger,
      preCompactTokenCount,
      capsule,
      ledger,
      suppressFollowUpQuestions,
      newestMessageFollows,
      beforeHookRows,
      count: meter.count,
    })

    const promptText = getFoldPrompt(effectiveInstructions, { runCapsulePresent: capsule !== null })
    const { splitRounds, response, rawSummary, proseSkipped, proseSkippedReceipt } = await summariseForFold({
      messages,
      context,
      summaryContext,
      summaryCacheSafeParams,
      promptText,
      gauge,
      overflow,
      preCompactTokenCount,
      landing,
      ceiling,
      fitsUnder,
    })

    if (overflow?.source === 'provider' && overflow.limitTokens !== undefined) {
      const providerLimit = overflow.limitTokens
      ceiling = ceiling !== undefined ? Math.min(ceiling, providerLimit) : providerLimit
      const providerLanding = foldLandingCeiling(
        providerLimit,
        messages,
        gauge?.density.ratio,
        gauge?.density.residuals,
        turnReserve,
      )
      landing = landing !== undefined ? Math.min(landing, providerLanding) : providerLanding
    }

    context.onCompactProgress?.({ type: 'stage', stage: 'restoring' })
    const prose = proseSkipped ?? rawSummary
    const memoryEnvelope = retireFoldToMemory({
      messages,
      owner,
      epoch: ledger.epoch,
      records: ledger.totals.records,
      aborted: context.abortController.signal.aborted,
      ...(context.agentId !== undefined ? { agent: String(context.agentId) } : {}),
      wrote: id => {
        writtenMemoryId = id
      },
    })
    const memoryText = renderFoldMemory(memoryEnvelope)

    const selectTail = (opts: Parameters<typeof computeVerbatimRecentTail>[1]) =>
      computeVerbatimRecentTail(messages, { keepRounds: DEFAULT_KEEP_ROUNDS, ...opts })

    let tailChoice: ReturnType<typeof chooseFoldTail>
    try {
      tailChoice = chooseFoldTail({ selectTail, fitsUnder, prose, memoryText, landing, ceiling })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${ERROR_MESSAGE_POST_FOLD_OVER_THRESHOLD}: ${detail}`)
    }
    const { messagesToKeep, tailPrecedingUuid, recentRounds, foldTarget } = tailChoice

    const keptUuids = messagesToKeep !== undefined ? new Set(messagesToKeep.map(row => row.uuid)) : undefined
    const operatorAttachment = selectOperatorMessages(messages, keptUuids !== undefined ? { keptUuids } : undefined)
    const operatorMessages = operatorAttachment !== null ? createAttachmentMessage(operatorAttachment) : undefined
    if (operatorAttachment !== null) {
      const kept = operatorAttachment.messages.length
      logForDebugging(`compact: operator messages block carries ${kept} of ${kept + operatorAttachment.omitted} prompts verbatim`)
    }

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const nestedMemoryBeforeFold = context.loadedNestedMemoryPaths ? [...context.loadedNestedMemoryPaths] : undefined
    const readSnapshot = snapshotAndClearReadState(context)
    const attachments = await assembleAttachments(
      readSnapshot,
      context,
      messagesToKeep ?? [],
      'compact_full',
      ledgerBeforeFold,
      undefined,
      refoldInfo?.restoreFiles ?? true,
    )

    const preCompactDiscoveredTools = [...extractDiscoveredToolNames(messages)].sort()
    const { boundaryMarker, summaryMessage } = buildBoundaryAndSummary({
      messages,
      boundaryTrigger,
      preCompactTokenCount,
      messagesToKeep,
      tailPrecedingUuid,
      recentRounds,
      memoryEnvelope,
      memoryText,
      gauge,
      overflow,
      preCompactDiscoveredTools,
      prose,
      capsule,
      ledger,
      suppressFollowUpQuestions,
      newestMessageFollows,
    })

    const responseUsage = response?.message.usage
    const callUsageTotal = responseUsage
      ? (responseUsage.input_tokens ?? 0) +
        (responseUsage.cache_read_input_tokens ?? 0) +
        (responseUsage.cache_creation_input_tokens ?? 0) +
        (responseUsage.output_tokens ?? 0)
      : 0
    const compactionUsage = toFoldUsage(responseUsage)
    const notes = proseSkippedReceipt !== undefined ? [proseSkippedReceipt] : undefined

    const initialPartial: FoldResult = {
      boundaryMarker,
      ...(operatorMessages !== undefined ? { operatorMessages } : {}),
      summaryMessages: [summaryMessage],
      ...(messagesToKeep !== undefined ? { messagesToKeep } : {}),
      attachments,
      hookResults: beforeHookRows,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      ...(compactionUsage !== undefined ? { compactionUsage } : {}),
      ...(notes !== undefined ? { notes } : {}),
    }

    const carried = carryFoldPrefix(
      messages,
      buildPostFoldMessages(initialPartial),
      String(rosterOwner),
      context.options.engineModel,
      responseUsage,
      new Set(preCompactDiscoveredTools),
      foldDefersNow(context),
    )
    boundaryMarker.compactMetadata.cacheEpoch = carried.receipt
    if (carried.attachment !== undefined) {
      attachments.push(carried.attachment)
    }

    const landed = landFold(initialPartial, messagesToKeep, recentRounds, {
      messages,
      boundary: boundaryMarker,
      ledger,
      prose,
      capsule,
      memoryText,
      suppressFollowUpQuestions,
      newestMessageFollows,
      before: meter.before,
      landing,
      ceiling,
      foldTarget,
      splitRounds,
      selectTail,
      landingCount: meter.count,
    })
    boundaryMarker.compactMetadata.ledger = withKeptLedgerRows(ledger, landed.messagesToKeep)

    if (refoldInfo?.mustShrink && landed.truePostCompactTokenCount >= meter.before) {
      restoreReadState(context, ledgerBeforeFold, nestedMemoryBeforeFold)
      logForDebugging(
        `compact: aborted after summariser — folded context ${landed.truePostCompactTokenCount} >= ${meter.before} (pre ${preCompactTokenCount}); original context kept`,
      )
      throw new Error(nothingToFoldLine(preCompactTokenCount, 'would-not-shrink'))
    }

    pruneReadFileState(context, landed.partial, landed.messagesToKeep)

    if (context.abortController.signal.aborted) {
      throw new APIUserAbortError()
    }
    const after = meter.after(landed.truePostCompactTokenCount)
    const tokensAfter = refoldInfo?.mustShrink ? after.tokens : landed.truePostCompactTokenCount
    boundaryMarker.compactMetadata.postTokens = tokensAfter
    if (refoldInfo?.mustShrink) {
      boundaryMarker.compactMetadata.postEstimate = {
        model: context.options.engineModel,
        tokens: after.estimate,
      }
    }

    return await finishCommittedFold({
      context,
      owner,
      foldTx,
      clearWrittenMemory: () => {
        writtenMemoryId = undefined
      },
      landed,
      beforeHookRows,
      boundaryTrigger,
      isAutoFold,
      preCompactTokenCount,
      tokensAfter,
      prose,
      proseSkippedReceipt,
      rawSummary,
      capsule,
      querySource: refoldInfo?.querySource ?? context.options.querySource,
    })
  } catch (error) {
    if (writtenMemoryId !== undefined) {
      const stays = withdrawFoldMemory(writtenMemoryId)
      if (stays !== null) {
        logForDebugging(`compact: the memory row ${writtenMemoryId} of a fold that did not land stays — ${stays}`, { level: 'warn' })
      }
    }
    if (!isAutoFold) {
      notifyFoldError(context, error)
    }
    throw error
  } finally {
    restoreAfterFold(context)
  }
}
