import type { ToolUseContext } from '../../../Tool.js'
import type { NonNullableUsage } from '../../../utils/api/emptyUsage.js'
import type { Message, PartialCompactDirection, UserMessage } from '../../../types/message.js'
import type { UUID } from 'node:crypto'
import { createAttachmentMessage } from '../../attachments/orchestrator.js'
import type { CacheSafeParams } from '../../agents/forkedAgent.js'
import { hookRowsOfResult } from '../../../utils/hooks/rows.js'
import { createCompactBoundaryMessage, createUserMessage, isCompactBoundaryMessage } from '../../../utils/messages.js'
import { reAppendSessionMetadata } from '../../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { tokenCountWithEstimation } from '../../context/tokens.js'
import { extractDiscoveredToolNames } from '../../../utils/toolSearch.js'
import { APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import { releaseLspDocumentsForContext } from '../../lsp/manager.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger } from '../foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { estimateContextTokens } from '../microCompact.js'
import { getCompactUserSummaryMessage, getPartialCompactPrompt, renderFoldedWork } from '../prompt.js'
import { selectOperatorMessages } from '../../../utils/compact/operatorMessages.js'
import { prepareFoldContext } from '../foldTransaction.js'
import { carryFoldPrefix } from '../cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../../providers/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../../../utils/messages/apiFilters.js'
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
  try {
    const summarize = direction === 'from' ? allMessages.slice(pivotIndex) : allMessages.slice(0, pivotIndex)
    let kept: Message[]
    if (direction === 'from') {
      kept = allMessages.slice(0, pivotIndex).filter(message => !isProgressMessage(message))
    } else {
      kept = stripThinkingFromIndex(
        allMessages
          .slice(pivotIndex)
          .filter(
            message =>
              !isProgressMessage(message) &&
              !isCompactBoundaryMessage(message) &&
              !(message.type === 'user' && (message as UserMessage).isCompactSummary === true),
          ),
        0,
      )
    }
    if (summarize.length === 0) {
      throw new Error(
        direction === 'from'
          ? 'Nothing to summarize after the selected message.'
          : 'Nothing to summarize before the selected message.',
      )
    }
    const preCompactTokenCount = tokenCountWithEstimation(allMessages)

    context.setSDKStatus?.('compacting')
    const before = await compactionBeforeHooks(context, { trigger: 'manual', ...(userFeedback?.trim() ? { instructions: userFeedback.trim() } : {}), tokens: preCompactTokenCount })
    const beforeRows: Message[] = hookRowsOfResult(before).map(row => createAttachmentMessage(row))
    const feedbackText = userFeedback?.trim() ? `User context for the summary:\n${userFeedback.trim()}` : undefined
    const hookText = boundedHookInstructions(before.answer.instructions)
    const customInstructions =
      hookText !== undefined && feedbackText !== undefined
        ? `${hookText}\n\n${feedbackText}`
        : (hookText ?? feedbackText)

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })
    const promptText = getPartialCompactPrompt(customInstructions, direction)
    const apiMessages = direction === 'up_to' ? summarize : allMessages
    const response = await summarizeWithPtlRetry(apiMessages, cacheSafeParams, promptText, context)
    const rawSummary = validateSummary(response, false)

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    const attachments = await assembleAttachments(snapshot, context, kept, 'compact_partial', ledgerBeforeFold)

    let anchorUuid: UUID | undefined
    if (direction === 'up_to') {
      for (let index = pivotIndex - 1; index >= 0; index--) {
        const candidate = allMessages[index] as Message
        if (!isProgressMessage(candidate)) {
          anchorUuid = candidate.uuid
          break
        }
      }
    } else {
      anchorUuid = kept.length > 0 ? (kept[kept.length - 1] as Message).uuid : undefined
    }
    const boundary = createCompactBoundaryMessage('manual', preCompactTokenCount, anchorUuid, userFeedback, summarize.length)
    const discovered = extractDiscoveredToolNames(allMessages)
    if (discovered.size > 0) boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()

    const ledger = buildFoldLedger(allMessages, ownerFromToolUseContext(context), getContextEpoch(ownerFromToolUseContext(context)).epoch + 1)
    boundary.compactMetadata.ledger = ledger
    const foldedWork = renderFoldedWork(foldedWorkOf(allMessages, kept, boundary.uuid))
    const summaryText = getCompactUserSummaryMessage(foldedWork === null ? rawSummary : `${rawSummary}\n\n${foldedWork}`, false, getTranscriptPath(), false) + `\n\n${renderFoldLedger(ledger)}`
    const summaryMessage =
      kept.length > 0
        ? createUserMessage({
            content: summaryText,
            isCompactSummary: true,
            summarizeMetadata: { messagesSummarized: summarize.length, userContext: userFeedback, direction },
          })
        : createUserMessage({ content: summaryText, isCompactSummary: true, isVisibleInTranscriptOnly: true })

    const relinkAnchor = direction === 'from' ? boundary.uuid : summaryMessage.uuid
    annotateBoundaryWithPreservedSegment(boundary, relinkAnchor, kept)
    annotateBoundaryWithWork(boundary, allMessages, kept, summaryMessage.uuid)

    if (context.agentId === undefined) reAppendSessionMetadata()

    const usage = (response.message as { usage?: NonNullableUsage }).usage
    const callUsageTotal = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      : 0
    const operatorSelection = selectOperatorMessages(summarize)
    const partialResult: CompactionResult = {
      boundaryMarker: boundary,
      operatorMessages: operatorSelection === null ? undefined : createAttachmentMessage(operatorSelection),
      summaryMessages: [summaryMessage],
      messagesToKeep: kept,
      attachments,
      hookResults: beforeRows,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
    }
    const cacheEpoch = carryFoldPrefix(allMessages, buildPostCompactMessages(partialResult), String(rosterOwnerFromToolUseContext(context)), context.options.engineModel, usage, discovered, foldDefersNow(context))
    boundary.compactMetadata.cacheEpoch = cacheEpoch.receipt
    if (cacheEpoch.attachment) partialResult.attachments.push(cacheEpoch.attachment)
    const truePostCompactTokenCount = estimateContextTokens(buildPostCompactMessages(partialResult))
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    boundary.compactMetadata.postTokens = truePostCompactTokenCount
    const afterRows = await compactionAfterHooks(context, { method: 'summary', trigger: 'manual', tokensBefore: preCompactTokenCount, tokensAfter: truePostCompactTokenCount, summary: rawSummary })
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    await releaseLspDocumentsForContext('compact_partial')
    transaction.commit()
    restoreBoundPrefixFromMessages(buildPostCompactMessages(partialResult), { rosterOnly: context.agentId !== undefined, fold: true })
    return {
      ...partialResult,
      hookResults: [...beforeRows, ...afterRows],
      truePostCompactTokenCount,
    }
  } catch (err) {
    notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}
