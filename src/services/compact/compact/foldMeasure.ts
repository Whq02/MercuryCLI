import type { AttachmentMessage, Message } from '../../../types/message.js'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { tokenCountWithEstimation } from '../../context/tokens.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { estimateRequestGauge, readRequestGauge } from '../../run/requestGauge.js'
import { renderFoldLedger, type FoldLedger } from '../foldLedger.js'
import { estimateContextTokens } from '../microCompact.js'
import { getCompactUserSummaryMessage } from '../prompt.js'
import { buildPostCompactMessages, type CompactionResult } from './result.js'

type FoldMeter = {
  gauge: ReturnType<typeof readRequestGauge>
  context: number
  before: number
  count: (rows: Message[]) => number
  measureResult: (result: CompactionResult) => number
}

export function createFoldMeter(
  messages: Message[],
  model: string,
  postFoldCarry?: readonly Message[],
): FoldMeter {
  const gauge = readRequestGauge(messages, model)
  const context = tokenCountWithEstimation(messages)
  const carry = postFoldCarry ?? []
  const count = (rows: Message[]): number => {
    const request = carry.length > 0 ? [...rows, ...carry] : rows
    return gauge
      ? estimateRequestGauge(request, gauge.fixed, gauge.density, model)
      : estimateContextTokens(request, model)
  }
  const estimatedBefore = count(stripThinkingFromIndex(messages, 0))
  const before = gauge ? Math.min(estimatedBefore, gauge.tokens) : estimatedBefore
  const measureResult = (result: CompactionResult): number => count(buildPostCompactMessages(result))
  return { gauge, context, before, count, measureResult }
}

export function composeFoldSummaryText(parts: {
  prose: string
  capsule: string | null
  work: string | null
  memoryText: string | null
  ledger: FoldLedger
  suppressFollowUpQuestions: boolean
  keptTail: boolean
  newestMessageFollows: boolean
}): string {
  const body = [parts.prose, parts.capsule, parts.work, parts.memoryText]
    .filter((part): part is string => part !== null)
    .join('\n\n')
  return (
    getCompactUserSummaryMessage(
      body,
      parts.suppressFollowUpQuestions,
      getTranscriptPath(),
      parts.keptTail,
      parts.newestMessageFollows,
    ) + `\n\n${renderFoldLedger(parts.ledger)}`
  )
}

export function isRestoredFileAttachment(message: AttachmentMessage): boolean {
  return message.attachment.type === 'file' || message.attachment.type === 'compact_file_reference'
}

export function withoutRestoredFiles(attachments: AttachmentMessage[]): AttachmentMessage[] {
  return attachments.filter(message => !isRestoredFileAttachment(message))
}
