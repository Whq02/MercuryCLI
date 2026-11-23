import type { ToolUseContext } from '../../Tool.js'
import type { NonNullableUsage } from '../../utils/api/emptyUsage.js'
import type { ApiUsage } from '../../types/wire.js'
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
import { computeVerbatimRecentTail, DEFAULT_KEEP_ROUNDS, foldLandingCeiling, foldableResults, foldedResultPlaceholder, withFoldedResults } from './verbatimTail.js'
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
import { summariseForFold, type FitsUnder } from './compact/foldSummary.js'
import { chooseFoldTail } from './compact/foldTail.js'
import { landFold } from './compact/foldLanding.js'
import { composeFoldSummaryText, createFoldMeter } from './compact/foldMeasure.js'

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

function toCompactionUsage(usage: ApiUsage | undefined): NonNullableUsage | undefined {
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
    return { state: 'installed', reason: 'run continuation capsule installed' }
  }
  return { state: 'none', reason: 'no substantive run state' }
}

function pruneReadFileState(
  context: ToolUseContext,
  result: CompactionResult,
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
  boundaryTrigger: CompactMetadata['trigger']
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
    const probeBoundary = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount)
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
  boundaryTrigger: CompactMetadata['trigger']
  preCompactTokenCount: number
  messagesToKeep: Message[] | undefined
  tailPrecedingUuid: Message['uuid'] | undefined
  recentRounds: CompactMetadata['recentRounds']
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
}): { boundaryMarker: ReturnType<typeof createCompactBoundaryMessage>; summaryMessage: UserMessage } {
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
  const boundaryMarker = createCompactBoundaryMessage(
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
  if (recentRounds !== undefined) {
    boundaryMarker.compactMetadata.recentRounds = recentRounds
  }
  if (overflow !== undefined) {
    boundaryMarker.compactMetadata.overflow = overflow
  }
  if (preCompactDiscoveredTools.length > 0) {
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = preCompactDiscoveredTools
  }

  const workPlaceholderSummary = createUserMessage({
    content: '',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  })
  const work = foldedWorkOf(messages, messagesToKeep ?? [], workPlaceholderSummary.uuid)
  const summaryText = composeFoldSummaryText({
    prose,
    capsule,
    work: renderFoldedWork(work),
    memoryText,
    ledger,
    suppressFollowUpQuestions,
    keptTail: (messagesToKeep?.length ?? 0) > 0,
    newestMessageFollows,
  })
  const summaryMessage: UserMessage = {
    ...workPlaceholderSummary,
    message: { ...workPlaceholderSummary.message, content: summaryText },
  }
  annotateBoundaryWithPreservedSegment(boundaryMarker, summaryMessage.uuid, messagesToKeep ?? [])
  annotateBoundaryWithWork(boundaryMarker, messages, messagesToKeep ?? [], summaryMessage.uuid)
  return { boundaryMarker, summaryMessage }
}

function checkFixedObligations(params: {
  ceiling: number | undefined
  boundaryTrigger: CompactMetadata['trigger']
  preCompactTokenCount: number
  messages: Message[]
  ledger: ReturnType<typeof buildFoldLedger>
  beforeHookRows: Message[]
  count: (rows: Message[]) => number
}): void {
  const { ceiling, boundaryTrigger, preCompactTokenCount, messages, ledger, beforeHookRows, count } = params
  if (ceiling === undefined) return
  const probeBoundary = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount)
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
  boundaryTrigger: CompactMetadata['trigger']
  trigger: 'auto' | 'manual'
  isAutoCompact: boolean
  overflow: OverflowSignal | undefined
  preCompactTokenCount: number
  prose: string
  proseSkippedReceipt: string | undefined
  rawSummary: string
  capsule: string | null
  querySource: string | undefined
}): Promise<CompactionResult> {
  const {
    context,
    owner,
    foldTx,
    clearWrittenMemory,
    landed,
    beforeHookRows,
    boundaryTrigger,
    trigger,
    isAutoCompact,
    overflow,
    preCompactTokenCount,
    prose,
    proseSkippedReceipt,
    rawSummary,
    capsule,
    querySource,
  } = params
  const afterHookRows = await compactionAfterHooks(context, {
    method: 'summary',
    trigger: boundaryTrigger,
    tokensBefore: preCompactTokenCount,
    tokensAfter: landed.truePostCompactTokenCount,
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

  const finalResult: CompactionResult = {
    ...landed.partial,
    hookResults,
    truePostCompactTokenCount: landed.truePostCompactTokenCount,
  }
  restoreBoundPrefixFromMessages(buildPostCompactMessages(finalResult), { fold: true })

  advanceContextEpoch(owner, {
    kind: isAutoCompact ? 'auto-compact' : 'manual-compact',
    reason: overflow !== undefined ? `overflow:${overflow.shape}` : trigger,
    tokensBefore: preCompactTokenCount,
    tokensAfter: landed.truePostCompactTokenCount,
    preservedTailCount: landed.messagesToKeep?.length ?? 0,
    capsule: resolveCapsuleState(proseSkippedReceipt, rawSummary, capsule),
  })

  if (context.agentId === undefined) {
    reAppendSessionMetadata()
  }
  return finalResult
}

export async function compactConversation(
  messages: Message[],
  incomingContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact = false,
  recompactionInfo?: RecompactionInfo,
  overflow?: OverflowSignal,
  summaryModel?: string,
): Promise<CompactionResult> {
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

    const trigger: 'auto' | 'manual' = isAutoCompact ? 'auto' : 'manual'
    const boundaryTrigger: CompactMetadata['trigger'] = overflow !== undefined ? 'overflow' : trigger

    const meter = createFoldMeter(messages, context.options.engineModel, cacheSafeParams.postFoldCarry)
    const preCompactTokenCount = meter.context
    const gauge = meter.gauge

    context.setSDKStatus?.('compacting')
    const beforeHooks = await compactionBeforeHooks(context, {
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
    let ceiling = recompactionInfo?.autoCompactThreshold
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

    const promptText = getCompactPrompt(effectiveInstructions, { runCapsulePresent: capsule !== null })
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
      epoch: nextEpoch,
      records: ledger.sourceRecordIds.length,
      aborted: context.abortController.signal.aborted,
      agent: context.agentId,
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
      throw new Error(`${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: ${detail}`)
    }
    const { messagesToKeep, tailPrecedingUuid, recentRounds, foldTarget } = tailChoice

    const keptUuids = messagesToKeep !== undefined ? new Set(messagesToKeep.map(row => row.uuid)) : undefined
    const operatorAttachment = selectOperatorMessages(messages, keptUuids !== undefined ? { keptUuids } : undefined)
    const operatorMessages = operatorAttachment !== null ? createAttachmentMessage(operatorAttachment) : undefined

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
      recompactionInfo?.restoreFiles ?? true,
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
    const compactionUsage = toCompactionUsage(responseUsage)
    const notes = proseSkippedReceipt !== undefined ? [proseSkippedReceipt] : undefined

    const initialPartial: CompactionResult = {
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
      buildPostCompactMessages(initialPartial),
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

    if (recompactionInfo?.mustShrink && landed.truePostCompactTokenCount >= meter.before) {
      restoreReadState(context, ledgerBeforeFold, nestedMemoryBeforeFold)
      logForDebugging(
        `compact: manual fold would not shrink context (${landed.truePostCompactTokenCount} >= ${meter.before}); keeping original context`,
      )
      throw new Error(nothingToCompactLine(meter.context, 'would-not-shrink'))
    }

    pruneReadFileState(context, landed.partial, landed.messagesToKeep)

    if (context.abortController.signal.aborted) {
      throw new APIUserAbortError()
    }
    const after = meter.after(landed.truePostCompactTokenCount)
    boundaryMarker.compactMetadata.postTokens = after.tokens
    if (recompactionInfo?.mustShrink) {
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
      trigger,
      isAutoCompact,
      overflow,
      preCompactTokenCount,
      prose,
      proseSkippedReceipt,
      rawSummary,
      capsule,
      querySource: recompactionInfo?.querySource ?? context.options.querySource,
    })
  } catch (error) {
    if (writtenMemoryId !== undefined) {
      withdrawFoldMemory(writtenMemoryId)
    }
    if (!isAutoCompact) {
      notifyCompactionError(context, error)
    }
    throw error
  } finally {
    restoreAfterCompaction(context)
  }
}
