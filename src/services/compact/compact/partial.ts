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

function isProgressMessage(message: Message): boolean {
  return message.type === 'progress'
}

export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult> {
  const transaction = prepareFoldContext(context)
  context = transaction.context
  const isFrom = direction === 'from'
  const summarize = isFrom ? allMessages.slice(pivotIndex) : allMessages.slice(0, pivotIndex)
  const kept = isFrom
    ? allMessages.slice(0, pivotIndex).filter(message => !isProgressMessage(message))
    : stripThinkingFromIndex(
        allMessages
          .slice(pivotIndex)
          .filter(
            message =>
              !isProgressMessage(message) &&
              !isCompactBoundaryMessage(message) &&
              !(message.type === 'user' && message.isCompactSummary === true),
          ),
        0,
      )
  if (summarize.length === 0) {
    throw new Error(
      isFrom
        ? 'Nothing to summarize after the selected message.'
        : 'Nothing to summarize before the selected message.',
    )
  }

  const preCompactTokenCount = tokenCountWithEstimation(allMessages)
  const trimmedFeedback = userFeedback?.trim()
  const feedbackOrUndefined = trimmedFeedback ? trimmedFeedback : undefined

  try {
    context.setSDKStatus?.('compacting')
    const beforeHooks = await compactionBeforeHooks(context, {
      trigger: 'manual',
      ...(feedbackOrUndefined !== undefined ? { instructions: feedbackOrUndefined } : {}),
      tokens: preCompactTokenCount,
    })
    const beforeHookRows: Message[] = hookRowsOfResult(beforeHooks).map(row => createAttachmentMessage(row))
    const boundedHook = boundedHookInstructions(beforeHooks.answer.instructions)
    const instructionParts: string[] = []
    if (boundedHook !== undefined) instructionParts.push(boundedHook)
    if (feedbackOrUndefined !== undefined) {
      instructionParts.push(`User context for the summary:\n${feedbackOrUndefined}`)
    }
    const combinedInstructions = instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    const promptText = getPartialCompactPrompt(combinedInstructions, direction)
    const response = await summarizeWithPtlRetry(
      isFrom ? allMessages : summarize,
      cacheSafeParams,
      promptText,
      context,
    )
    const rawSummary = validateSummary(response, false)

    const readFileLedger = Array.from(context.readFileState.entries())
    const readFileSnapshot = snapshotAndClearReadState(context)
    const attachments = await assembleAttachments(
      readFileSnapshot,
      context,
      kept,
      'compact_partial',
      readFileLedger,
    )

    let anchorUuid: UUID | undefined
    if (isFrom) {
      anchorUuid = kept.length > 0 ? kept[kept.length - 1]!.uuid : undefined
    } else {
      const lastNonProgress = allMessages.slice(0, pivotIndex).findLast(message => !isProgressMessage(message))
      anchorUuid = lastNonProgress?.uuid
    }

    const boundaryMarker = createCompactBoundaryMessage(
      'manual',
      preCompactTokenCount,
      anchorUuid,
      feedbackOrUndefined,
      summarize.length,
    )
    const discoveredTools = extractDiscoveredToolNames(allMessages)
    if (discoveredTools.size > 0) {
      boundaryMarker.compactMetadata.preCompactDiscoveredTools = [...discoveredTools].sort()
    }

    const owner = ownerFromToolUseContext(context)
    const epoch = getContextEpoch(owner).epoch + 1
    const ledger = withKeptLedgerRows(buildFoldLedger(allMessages, owner, epoch), kept)
    boundaryMarker.compactMetadata.ledger = ledger

    const workText = renderFoldedWork(foldedWorkOf(allMessages, kept, boundaryMarker.uuid))
    const summaryBody = workText !== null ? `${rawSummary}\n\n${workText}` : rawSummary
    const formattedSummary =
      getCompactUserSummaryMessage(summaryBody, false, getTranscriptPath(), kept.length > 0) +
      `\n\n${renderFoldLedger(ledger)}`

    const summaryMessage: UserMessage = createUserMessage({
      content: formattedSummary,
      isCompactSummary: true,
      ...(kept.length > 0
        ? {
            summarizeMetadata: {
              messagesSummarized: summarize.length,
              ...(feedbackOrUndefined !== undefined ? { userContext: feedbackOrUndefined } : {}),
              direction,
            },
          }
        : { isVisibleInTranscriptOnly: true }),
    })

    annotateBoundaryWithPreservedSegment(
      boundaryMarker,
      isFrom ? boundaryMarker.uuid : summaryMessage.uuid,
      kept,
    )
    annotateBoundaryWithWork(boundaryMarker, allMessages, kept, summaryMessage.uuid)

    if (context.agentId === undefined) {
      reAppendSessionMetadata()
    }

    const operatorAttachment = selectOperatorMessages(summarize)
    const operatorMessages = operatorAttachment !== null ? createAttachmentMessage(operatorAttachment) : undefined

    const rawUsage = response.message.usage
    const compactionUsage: NonNullableUsage | undefined = rawUsage
      ? {
          input_tokens: rawUsage.input_tokens ?? 0,
          cache_creation_input_tokens: rawUsage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: rawUsage.cache_read_input_tokens ?? 0,
          output_tokens: rawUsage.output_tokens ?? 0,
          server_tool_use: rawUsage.server_tool_use ?? { web_fetch_requests: 0, web_search_requests: 0 },
          service_tier: rawUsage.service_tier ?? null,
          cache_creation: rawUsage.cache_creation ?? { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          inference_geo: rawUsage.inference_geo ?? null,
          iterations: rawUsage.iterations ?? null,
          speed: rawUsage.speed ?? null,
          output_tokens_details: rawUsage.output_tokens_details ?? null,
        }
      : undefined
    const callUsageTotal = compactionUsage
      ? compactionUsage.input_tokens +
        compactionUsage.cache_read_input_tokens +
        compactionUsage.cache_creation_input_tokens +
        compactionUsage.output_tokens
      : 0

    const partialResult: CompactionResult = {
      boundaryMarker,
      ...(operatorMessages !== undefined ? { operatorMessages } : {}),
      summaryMessages: [summaryMessage],
      ...(kept.length > 0 ? { messagesToKeep: kept } : {}),
      attachments,
      hookResults: beforeHookRows,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      ...(compactionUsage !== undefined ? { compactionUsage } : {}),
    }

    const carried = carryFoldPrefix(
      allMessages,
      buildPostCompactMessages(partialResult),
      rosterOwnerFromToolUseContext(context),
      context.options.engineModel,
      rawUsage,
      discoveredTools,
      foldDefersNow(context),
    )
    boundaryMarker.compactMetadata.cacheEpoch = carried.receipt
    if (carried.attachment !== undefined) {
      attachments.push(carried.attachment)
    }

    const truePostCompactTokenCount = estimateContextTokens(
      buildPostCompactMessages(partialResult),
      context.options.engineModel,
    )
    if (context.abortController.signal.aborted) {
      throw new APIUserAbortError()
    }

    boundaryMarker.compactMetadata.postTokens = truePostCompactTokenCount
    const afterHookRows = await compactionAfterHooks(context, {
      method: 'summary',
      trigger: 'manual',
      tokensBefore: preCompactTokenCount,
      tokensAfter: truePostCompactTokenCount,
      summary: rawSummary,
    })
    if (context.abortController.signal.aborted) {
      throw new APIUserAbortError()
    }

    await releaseLspDocumentsForContext('compact_partial')
    transaction.commit()

    const finalResult: CompactionResult = {
      ...partialResult,
      hookResults: [...beforeHookRows, ...afterHookRows],
      truePostCompactTokenCount,
    }
    restoreBoundPrefixFromMessages(buildPostCompactMessages(finalResult), { fold: true })
    return finalResult
  } catch (err) {
    notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}
