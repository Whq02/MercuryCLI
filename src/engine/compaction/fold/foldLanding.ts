import type { FoldMetadata, Message, SystemFoldBoundaryMessage } from '../../message-shapes/message.js'
import { createAttachmentMessage } from '../../attachments/turnAttachments.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { roughTokenCountEstimationForMessages } from '../../../models/facts/tokenEstimation.js'
import type { FoldLedger } from '../foldLedger.js'
import { renderFoldedWork } from '../summariserPrompt.js'
import { foldableResults, foldedResultPlaceholder, withFoldedResults } from '../verbatimTail.js'
import { selectOperatorMessages } from '../../compaction-window/operatorMessages.js'
import { type FoldResult, buildPostFoldMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './foldResult.js'
import { fitPostFoldUnderThreshold, postFoldOverThresholdMessage } from './foldAttachments.js'
import { composeFoldSummaryText, isRestoredFileAttachment, withoutRestoredFiles } from './foldMeasure.js'
import type { TailSelector } from './foldTail.js'

interface LandingNeeds {
  messages: Message[]
  boundary: SystemFoldBoundaryMessage
  ledger: FoldLedger
  prose: string
  capsule: string | null
  memoryText: string
  suppressFollowUpQuestions: boolean
  newestMessageFollows: boolean
  before: number
  landing: number | undefined
  ceiling: number | undefined
  foldTarget: number | undefined
  splitRounds: number
  selectTail: TailSelector
  landingCount: (rows: Message[]) => number
}

export function landFold(partial: FoldResult, messagesToKeep: Message[] | undefined, recentRounds: FoldMetadata['recentRounds'], { messages, boundary, ledger, prose, capsule, memoryText, suppressFollowUpQuestions, newestMessageFollows, before, landing, ceiling, foldTarget, splitRounds, selectTail, landingCount }: LandingNeeds): { partial: FoldResult; messagesToKeep: Message[] | undefined; truePostFoldTokenCount: number; folded: Map<string, string> } {
  let truePostFoldTokenCount = landingCount(buildPostFoldMessages(partial))
  const room = landing ?? ceiling
  if (room !== undefined && truePostFoldTokenCount >= room) {
    const fit = fitPostFoldUnderThreshold(partial, room, landingCount)
    if (fit.shed.length > 0) {
      logForDebugging(
        `compact: post-compact estimate ${truePostFoldTokenCount} >= the landing line ${room} (threshold ${ceiling}); shed ${fit.shed.join(', ')} → ${fit.estimate}`,
      )
    }
    partial = fit.result
    truePostFoldTokenCount = fit.estimate
  }

  const completeFit = room === undefined ? { result: partial, estimate: landingCount(buildPostFoldMessages(partial)) } : fitPostFoldUnderThreshold(partial, room, landingCount)
  partial = completeFit.result
  truePostFoldTokenCount = completeFit.estimate
  if (truePostFoldTokenCount >= before && partial.attachments.some(isRestoredFileAttachment)) {
    const withoutFiles = { ...partial, attachments: withoutRestoredFiles(partial.attachments) }
    const withoutFilesEstimate = landingCount(buildPostFoldMessages(withoutFiles))
    logForDebugging(
      `compact: post-compact estimate ${truePostFoldTokenCount} >= before ${before}; omitted restored file attachments → ${withoutFilesEstimate}`,
    )
    partial = withoutFiles
    truePostFoldTokenCount = withoutFilesEstimate
  }
  const folded = new Map<string, string>()
  const rekeep = (keep: Message[], rounds: NonNullable<FoldMetadata['recentRounds']>): void => {
    messagesToKeep = keep
    recentRounds = rounds
    boundary.compactMetadata.recentRounds = rounds
    const selection = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
    const work = renderFoldedWork(foldedWorkOf(messages, keep, boundary.uuid))
    const summaryText = composeFoldSummaryText({
      prose,
      capsule,
      work,
      memoryText,
      ledger,
      suppressFollowUpQuestions,
      keptTail: true,
      newestMessageFollows,
    })
    partial = { ...partial, messagesToKeep: keep, operatorMessages: selection ? createAttachmentMessage(selection) : undefined, summaryMessages: partial.summaryMessages.map((row, index) => index === 0 ? { ...row, message: { ...row.message, content: summaryText } } : row) }
    annotateBoundaryWithPreservedSegment(boundary, partial.summaryMessages.at(-1)!.uuid, keep)
    annotateBoundaryWithWork(boundary, messages, keep, partial.summaryMessages.at(-1)!.uuid)
    const fitted = fitPostFoldUnderThreshold(partial, room ?? Infinity, landingCount)
    partial = fitted.result
    truePostFoldTokenCount = fitted.estimate
  }
  const widest = { partial, messagesToKeep, recentRounds, logicalParentUuid: boundary.logicalParentUuid, estimate: truePostFoldTokenCount }
  while (room !== undefined && foldTarget === undefined && truePostFoldTokenCount >= room && recentRounds !== undefined && recentRounds.kept > Math.max(1, splitRounds)) {
    const narrower = selectTail({ keepRounds: recentRounds.kept - 1 })
    if (narrower === null) break
    boundary.logicalParentUuid = narrower.precedingUuid
    rekeep(stripThinkingFromIndex(narrower.keep, 0), { requested: recentRounds.requested, kept: narrower.roundsKept, tokens: narrower.estimatedTokens, reason: 'request-budget' })
  }
  if (room !== undefined && messagesToKeep !== undefined && recentRounds !== undefined) {
    const whole = messagesToKeep
    const target = foldTarget ?? room
    for (const result of foldableResults(whole)) {
      if (truePostFoldTokenCount < target) break
      folded.set(result.toolUseId, foldedResultPlaceholder(result))
      const keep = withFoldedResults(whole, folded)
      rekeep(keep, { ...recentRounds, tokens: roughTokenCountEstimationForMessages(keep), folded: folded.size })
    }
  }
  if (landing !== undefined && truePostFoldTokenCount >= landing && recentRounds !== undefined) {
    if (widest.recentRounds !== undefined && widest.estimate < (ceiling ?? Infinity)) {
      folded.clear()
      partial = widest.partial
      messagesToKeep = widest.messagesToKeep
      truePostFoldTokenCount = widest.estimate
      boundary.logicalParentUuid = widest.logicalParentUuid
      recentRounds = widest.recentRounds
      annotateBoundaryWithPreservedSegment(boundary, partial.summaryMessages.at(-1)!.uuid, messagesToKeep ?? [])
      annotateBoundaryWithWork(boundary, messages, messagesToKeep ?? [], partial.summaryMessages.at(-1)!.uuid)
    }
    recentRounds = { ...recentRounds, reason: 'no-room' }
    boundary.compactMetadata.recentRounds = recentRounds
  }
  if (ceiling !== undefined && truePostFoldTokenCount >= ceiling) throw new Error(postFoldOverThresholdMessage(truePostFoldTokenCount, ceiling))
  return { partial, messagesToKeep, truePostFoldTokenCount, folded }
}
