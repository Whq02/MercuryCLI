import type { CompactMetadata, Message, SystemCompactBoundaryMessage } from '../../../types/message.js'
import { createAttachmentMessage } from '../../attachments/orchestrator.js'
import { logForDebugging } from '../../../utils/debug.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { roughTokenCountEstimationForMessages } from '../../tokenEstimation.js'
import type { FoldLedger } from '../foldLedger.js'
import { renderFoldedWork } from '../prompt.js'
import { foldableResults, foldedResultPlaceholder, withFoldedResults } from '../verbatimTail.js'
import { selectOperatorMessages } from '../../../utils/compact/operatorMessages.js'
import { type CompactionResult, buildPostCompactMessages, annotateBoundaryWithPreservedSegment, foldedWorkOf, annotateBoundaryWithWork } from './result.js'
import { fitPostCompactUnderThreshold, postCompactOverThresholdMessage } from './attachments.js'
import { composeFoldSummaryText, isRestoredFileAttachment, withoutRestoredFiles } from './foldMeasure.js'
import type { TailSelector } from './foldTail.js'
import { notBuilt } from '../../../pi/holes.js'

interface LandingNeeds {
  messages: Message[]
  boundary: SystemCompactBoundaryMessage
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

export function landFold(partial: CompactionResult, messagesToKeep: Message[] | undefined, recentRounds: CompactMetadata['recentRounds'], arg3: LandingNeeds): { partial: CompactionResult; messagesToKeep: Message[] | undefined; truePostCompactTokenCount: number; folded: Map<string, string> } {
  return notBuilt('src/services/compact/compact/foldLanding.ts:33')
}
