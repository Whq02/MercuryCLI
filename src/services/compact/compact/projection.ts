import type { ToolUseContext } from '../../../Tool.js'
import type { Message, UserMessage } from '../../../types/message.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import type { CacheSafeParams } from '../../agents/forkedAgent.js'
import { createCompactBoundaryMessage, createUserMessage } from '../../../utils/messages.js'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { tokenCountWithEstimation } from '../../../utils/tokens.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger } from '../foldLedger.js'
import { ownerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../../run/runContinuationCapsule.js'
import { roughTokenCountEstimationForMessages } from '../../tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../../run/requestGauge.js'
import { getTurnReserveTokens } from '../../../utils/compact/autoCompactWindow.js'
import { groupMessagesByApiRound } from '../grouping.js'
import { estimateContextTokens } from '../microCompact.js'
import { getCompactUserSummaryMessage, renderFoldedWork } from '../prompt.js'
import { computeVerbatimRecentTail, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryCompactKeepTailEnabled, MIN_HEAD_ROUNDS, withFoldedResults } from '../verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from '../../../utils/compact/operatorMessages.js'
import { stripThinkingFromIndex } from '../../../utils/messages/apiFilters.js'
import { foldedWorkOf } from './result.js'
import { assembleAttachments } from './attachments.js'

const PROJECTED_SUMMARY_FLOOR_TOKENS = 2_000

export type ManualFoldProjection = {
  context: number
  before: number
  after: number
  kept: number
  folds: number
  workingRoundsFolded: number
}

export function isRefold(messages: readonly Message[]): boolean {
  return messages.some(row => row.type === 'user' && row.isCompactSummary === true)
}

export function manualFoldHasNothingToFold(projection: ManualFoldProjection): boolean {
  return projection.workingRoundsFolded < MIN_HEAD_ROUNDS || projection.after >= projection.before
}

export async function projectManualFold(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  ceiling: number | undefined,
): Promise<ManualFoldProjection | null> {
  if (messages.length === 0) return null
  const input = tokenCountWithEstimation(messages)
  const owner = ownerFromToolUseContext(context)
  const ledger = buildFoldLedger(messages, owner, getContextEpoch(owner).epoch + 1)
  const gauge = readRequestGauge(messages, context.options.engineModel)
  const landing = ceiling === undefined ? undefined : foldLandingCeiling(ceiling, messages, gauge?.density.ratio ?? 1, gauge?.density.residuals, getTurnReserveTokens(context.options.engineModel))
  const landingCount = (rows: Message[]): number => {
    const request = [...rows, ...(cacheSafeParams.postFoldCarry ?? [])]
    return gauge ? estimateRequestGauge(request, gauge.fixed, gauge.density, context.options.engineModel) : estimateContextTokens(request, context.options.engineModel)
  }
  const newestMessageFollows = (cacheSafeParams.postFoldCarry ?? []).some(row => operatorTextOf(row) !== null)
  const previousSummaries = messages.filter(row => row.type === 'user' && row.isCompactSummary === true)
  const standIn = 'summary '.repeat(Math.ceil(Math.max(PROJECTED_SUMMARY_FLOOR_TOKENS, roughTokenCountEstimationForMessages(previousSummaries)) / 2))
  const marker = createCompactBoundaryMessage('manual', input)
  const capsule = buildRunContinuationCapsule(owner, [...context.readFileState.keys()])
  const summaryOf = (keep: Message[]): UserMessage => {
    const work = renderFoldedWork(foldedWorkOf(messages, keep, marker.uuid))
    const text = getCompactUserSummaryMessage([standIn, capsule, work].filter((part): part is string => part !== null).join('\n\n'), false, getTranscriptPath(), keep.length > 0, newestMessageFollows) + `\n\n${renderFoldLedger(ledger)}`
    return createUserMessage({ content: text, isCompactSummary: true })
  }
  const operatorBlock = (keep: Message[]): Message[] => {
    const operator = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
    return operator ? [createAttachmentMessage(operator)] : []
  }
  const allFolded = (keep: Message[]): Message[] => withFoldedResults(keep, new Map(foldableResults(keep).map(result => [result.toolUseId, foldedResultPlaceholder(result)])))
  const fits = (limit: number | undefined, resultsFolded: boolean) => (keep: Message[]): boolean =>
    limit === undefined || landingCount([marker, ...operatorBlock(keep), summaryOf(keep), ...stripThinkingFromIndex(resultsFolded ? allFolded(keep) : keep, 0)]) < limit
  let keep: Message[] = []
  if (isMercuryCompactKeepTailEnabled()) {
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
  const workingRoundsFolded = groupMessagesByApiRound(head).filter(group => group.some(row => row.type === 'assistant')).length
  const snapshot: Record<string, { content: string; timestamp: number }> = {}
  for (const [path, state] of context.readFileState.entries()) snapshot[path] = { content: state.content, timestamp: state.timestamp }
  const attachments = await assembleAttachments(snapshot, context, keep, 'compact_full', [...context.readFileState.entries()], { userContext: cacheSafeParams.userContext })
  const after = landingCount([marker, ...operatorBlock(keep), summaryOf(keep), ...keep, ...attachments])
  return { context: input, before: landingCount(messages), after, kept: keep.length, folds: head.length, workingRoundsFolded }
}
