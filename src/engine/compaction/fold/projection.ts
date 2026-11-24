import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { Message, UserMessage } from '../../message-shapes/message.js'
import { createAttachmentMessage } from '../../attachments/turnAttachments.js'
import type { CacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import { createFoldBoundaryMessage, createUserMessage } from '../../messages/messages.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { buildFoldLedger } from '../foldLedger.js'
import { ownerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import { buildRunContinuationCapsule } from '../../run/runContinuationCapsule.js'
import { roughTokenCountEstimationForMessages } from '../../../models/facts/tokenEstimation.js'
import { getTurnReserveTokens } from '../../compaction-window/autoFoldWindow.js'
import { groupMessagesByApiRound } from '../groupByApiRound.js'
import { estimateContextTokens } from '../pruneToolResults.js'
import { renderFoldedWork } from '../summariserPrompt.js'
import { computeVerbatimRecentTail, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryFoldKeepTailEnabled, MIN_HEAD_ROUNDS, withFoldedResults } from '../verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from '../../compaction-window/operatorMessages.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { previewFoldMemoryText } from '../foldRetirement.js'
import { DEGRADED_SUMMARY_LENGTH, type NothingToFoldReason } from './foldLimits.js'
import { foldedWorkOf, type FoldResult } from './foldResult.js'
import { assembleAttachments } from './foldAttachments.js'
import { composeFoldSummaryText, createFoldMeter, isRestoredFileAttachment, withoutRestoredFiles } from './foldMeasure.js'

export type ManualFoldProjection = {
  context: number
  before: number
  after: number
  afterWithFiles: number
  restoreFiles: boolean
  kept: number
  keptTokens: number
  folds: number
  totalRounds: number
  workingRoundsFolded: number
}

export function isRefold(messages: readonly Message[]): boolean {
  return messages.some(row => row.type === 'user' && row.isCompactSummary === true)
}

export function manualFoldHasNothingToFold(projection: ManualFoldProjection): boolean {
  return projection.workingRoundsFolded < MIN_HEAD_ROUNDS || projection.after >= projection.before
}

export function nothingToFoldReason(projection: ManualFoldProjection, refold: boolean): NothingToFoldReason {
  if (refold && projection.workingRoundsFolded < MIN_HEAD_ROUNDS) return 'already-folded'
  if (projection.kept > 0 && projection.keptTokens * 2 >= projection.context) return 'recent-turns-kept'
  if (!refold && projection.totalRounds <= MIN_HEAD_ROUNDS) return 'too-few-messages'
  return 'would-not-shrink'
}

export async function projectManualFold(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  ceiling: number | undefined,
): Promise<ManualFoldProjection | null> {
  if (messages.length === 0) return null
  const meter = createFoldMeter(messages, context.options.engineModel, cacheSafeParams.postFoldCarry)
  const owner = ownerFromToolUseContext(context)
  const ledger = buildFoldLedger(messages, owner, getContextEpoch(owner).epoch + 1)
  const landing = ceiling === undefined ? undefined : foldLandingCeiling(ceiling, messages, meter.gauge?.density.ratio ?? 1, meter.gauge?.density.residuals, getTurnReserveTokens(context.options.engineModel))
  const newestMessageFollows = (cacheSafeParams.postFoldCarry ?? []).some(row => operatorTextOf(row) !== null)
  const previousSummaries = messages.filter(row => row.type === 'user' && row.isCompactSummary === true)
  const standIn = 'summary '.repeat(Math.ceil(Math.max(DEGRADED_SUMMARY_LENGTH / 4, roughTokenCountEstimationForMessages(previousSummaries)) / 2))
  const marker = createFoldBoundaryMessage('manual', meter.context)
  const capsule = buildRunContinuationCapsule(owner, [...context.readFileState.keys()])
  const memoryText = previewFoldMemoryText({
    messages,
    owner,
    epoch: ledger.epoch,
    records: ledger.totals.records,
    ...(context.agentId === undefined ? {} : { agent: String(context.agentId) }),
  })
  const summaryOf = (keep: Message[]): UserMessage => {
    const work = renderFoldedWork(foldedWorkOf(messages, keep, marker.uuid))
    const text = composeFoldSummaryText({
      prose: standIn,
      capsule,
      work,
      memoryText,
      ledger,
      suppressFollowUpQuestions: false,
      keptTail: keep.length > 0,
      newestMessageFollows,
    })
    return createUserMessage({ content: text, isCompactSummary: true })
  }
  const operatorBlock = (keep: Message[]) => {
    const operator = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
    return operator ? createAttachmentMessage(operator) : undefined
  }
  const allFolded = (keep: Message[]): Message[] => withFoldedResults(keep, new Map(foldableResults(keep).map(result => [result.toolUseId, foldedResultPlaceholder(result)])))
  const fits = (limit: number | undefined, resultsFolded: boolean) => (keep: Message[]): boolean => {
    if (limit === undefined) return true
    const operator = operatorBlock(keep)
    return meter.count([marker, ...(operator ? [operator] : []), summaryOf(keep), ...stripThinkingFromIndex(resultsFolded ? allFolded(keep) : keep, 0)]) < limit
  }
  let keep: Message[] = []
  if (isMercuryFoldKeepTailEnabled()) {
    let tail: ReturnType<typeof computeVerbatimRecentTail> | undefined
    for (const [limit, resultsFolded] of [[landing, false], [ceiling, false], [landing, true], [ceiling, true]] as const) {
      try {
        tail = computeVerbatimRecentTail(messages, { fits: fits(limit, resultsFolded) })
        break
      } catch {
        tail = undefined
      }
    }
    if (tail === undefined) return null
    if (tail !== null) keep = stripThinkingFromIndex(tail.keep, 0)
  }
  const keptUuids = new Set(keep.map(row => row.uuid))
  const head = messages.filter(row => !keptUuids.has(row.uuid))
  const totalRounds = groupMessagesByApiRound(messages).filter(group => group.some(row => row.type === 'assistant')).length
  const workingRoundsFolded = groupMessagesByApiRound(head).filter(group => group.some(row => row.type === 'assistant')).length
  const keptTokens = estimateContextTokens(keep, context.options.engineModel)
  const snapshot: Record<string, { content: string; timestamp: number }> = {}
  for (const [path, state] of context.readFileState.entries()) snapshot[path] = { content: state.content, timestamp: state.timestamp }
  const attachments = await assembleAttachments(snapshot, context, keep, 'compact_full', [...context.readFileState.entries()], { userContext: cacheSafeParams.userContext })
  const projectedResult = (rows: typeof attachments): FoldResult => ({
    boundaryMarker: marker,
    operatorMessages: operatorBlock(keep),
    summaryMessages: [summaryOf(keep)],
    messagesToKeep: keep.length > 0 ? keep : undefined,
    attachments: rows,
    hookResults: [],
    preCompactTokenCount: meter.context,
    postCompactTokenCount: 0,
  })
  const afterWithFiles = meter.measureResult(projectedResult(attachments))
  let after = afterWithFiles
  let restoreFiles = true
  if (afterWithFiles >= meter.before && attachments.some(isRestoredFileAttachment)) {
    after = meter.measureResult(projectedResult(withoutRestoredFiles(attachments)))
    restoreFiles = false
  }
  return { context: meter.context, before: meter.before, after, afterWithFiles, restoreFiles, kept: keep.length, keptTokens, folds: head.length, totalRounds, workingRoundsFolded }
}
