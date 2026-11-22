import type { ToolUseContext } from '../../../Tool.js'
import type { Message, UserMessage } from '../../../types/message.js'
import { createAttachmentMessage } from '../../attachments/orchestrator.js'
import type { CacheSafeParams } from '../../agents/forkedAgent.js'
import { createCompactBoundaryMessage, createUserMessage } from '../../messages.js'
import { getContextEpoch } from '../../run/contextEpochs.js'
import { buildFoldLedger } from '../foldLedger.js'
import { ownerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../../run/runContinuationCapsule.js'
import { roughTokenCountEstimationForMessages } from '../../tokenEstimation.js'
import { getTurnReserveTokens } from '../../../utils/compact/autoCompactWindow.js'
import { groupMessagesByApiRound } from '../grouping.js'
import { estimateContextTokens } from '../microCompact.js'
import { renderFoldedWork } from '../prompt.js'
import { computeVerbatimRecentTail, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryCompactKeepTailEnabled, MIN_HEAD_ROUNDS, withFoldedResults } from '../verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from '../../../utils/compact/operatorMessages.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { previewFoldMemoryText } from '../foldRetirement.js'
import { DEGRADED_SUMMARY_LENGTH, type NothingToCompactReason } from './limits.js'
import { foldedWorkOf, type CompactionResult } from './result.js'
import { assembleAttachments } from './attachments.js'
import { composeFoldSummaryText, createFoldMeter, isRestoredFileAttachment, withoutRestoredFiles } from './foldMeasure.js'
import { notBuilt } from '../../../pi/holes.js'

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

export function nothingToCompactReason(projection: ManualFoldProjection, refold: boolean): NothingToCompactReason {
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
  return notBuilt('src/services/compact/compact/projection.ts:52')
}
