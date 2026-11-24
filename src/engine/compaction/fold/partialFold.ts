import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { NonNullableUsage } from '../../request-parts/emptyUsage.js'
import type { Message, PartialFoldDirection, UserMessage } from '../../message-shapes/message.js'
import type { UUID } from 'node:crypto'
import { createAttachmentMessage } from '../../attachments/turnAttachments.js'
import type { CacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import { hookRowsOfResult } from '../../../integrations/event-hooks/rows.js'
import { createFoldBoundaryMessage, createUserMessage, isFoldBoundaryMessage } from '../../messages/messages.js'
import { reAppendSessionMetadata } from '../../../sessions/transcripts/sessionListings.js'
import { getTranscriptPath } from '../../../sessions/transcripts/paths.js'
import { tokenCountWithEstimation } from '../../context-window/contextTokenCount.js'
import { extractDiscoveredToolNames } from '../../messages/toolSearch.js'
import { APIUserAbortError } from '../../request-parts/sdkErrors.js'
import { releaseLspDocumentsForContext } from '../../../integrations/lsp/serverManagerLifecycle.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger, withKeptLedgerRows } from '../foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import { estimateContextTokens } from '../pruneToolResults.js'
import { getFoldUserSummaryMessage, getPartialFoldPrompt, renderFoldedWork } from '../summariserPrompt.js'
import { selectOperatorMessages } from '../../compaction-window/operatorMessages.js'
import { prepareFoldContext } from '../foldTransaction.js'
import { carryFoldPrefix } from '../cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../../../models/roads/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { type FoldResult, foldDefersNow, buildPostFoldMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './foldResult.js'
import { boundedHookInstructions } from './summariserInput.js'
import { snapshotAndClearReadState, assembleAttachments } from './foldAttachments.js'
import { validateSummary } from './summaryCheck.js'
import { summarizeWithPtlRetry } from './ladder.js'
import { foldBeforeHooks, foldAfterHooks } from './hooks.js'
import { notifyFoldError, restoreAfterFold } from './foldStatusAndRestore.js'

function isProgressMessage(message: Message): boolean {
  return message.type === 'progress'
}

export async function partialFoldConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialFoldDirection = 'from',
): Promise<FoldResult> {
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
              !isFoldBoundaryMessage(message) &&
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
    const beforeHooks = await foldBeforeHooks(context, {
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

    const promptText = getPartialFoldPrompt(combinedInstructions, direction)
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

    const boundaryMarker = createFoldBoundaryMessage(
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
    const ledger = buildFoldLedger(allMessages, owner, epoch)
    boundaryMarker.compactMetadata.ledger = withKeptLedgerRows(ledger, kept)

    const workText = renderFoldedWork(foldedWorkOf(allMessages, kept, boundaryMarker.uuid))
    const summaryBody = workText !== null ? `${rawSummary}\n\n${workText}` : rawSummary
    const formattedSummary =
      getFoldUserSummaryMessage(summaryBody, false, getTranscriptPath(), false) +
      `\n\n${renderFoldLedger(ledger)}`

    const summaryMessage: UserMessage = createUserMessage({
      content: formattedSummary,
      isCompactSummary: true,
      ...(kept.length > 0
        ? {
            summarizeMetadata: {
              messagesSummarized: summarize.length,
              userContext: userFeedback,
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

    const partialResult: FoldResult = {
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
      buildPostFoldMessages(partialResult),
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
      buildPostFoldMessages(partialResult),
      context.options.engineModel,
    )
    if (context.abortController.signal.aborted) {
      throw new APIUserAbortError()
    }

    boundaryMarker.compactMetadata.postTokens = truePostCompactTokenCount
    const afterHookRows = await foldAfterHooks(context, {
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

    const finalResult: FoldResult = {
      ...partialResult,
      hookResults: [...beforeHookRows, ...afterHookRows],
      truePostCompactTokenCount,
    }
    restoreBoundPrefixFromMessages(buildPostFoldMessages(finalResult), { fold: true })
    return finalResult
  } catch (err) {
    notifyFoldError(context, err)
    throw err
  } finally {
    restoreAfterFold(context)
  }
}
