import type { AttachmentMessage, Message } from '../../../types/message.js'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { contextFill } from '../../context/tokens.js'
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
  after: (landed: number) => number
}

export function createFoldMeter(
  messages: Message[],
  model: string,
  postFoldCarry?: readonly Message[],
): FoldMeter {
  const gauge = readRequestGauge(messages, model)
  const context = contextFill(messages).tokens
  const carry = postFoldCarry ?? []
  const count = (rows: Message[]): number => {
    const request = carry.length > 0 ? [...rows, ...carry] : rows
    return gauge
      ? estimateRequestGauge(request, gauge.fixed, gauge.density, model)
      : estimateContextTokens(request, model)
  }
  const before = count(withoutSkillsList(stripThinkingFromIndex(messages, 0)))
  const measureResult = (result: CompactionResult): number => count(buildPostCompactMessages(result))
  const foreign = measuredByAnotherFamily(messages, model)
  const after = (landed: number): number => (foreign ? landed : contextAfterFold(context, before, landed))
  return { gauge, context, before, count, measureResult, after }
}

export function measuredByAnotherFamily(messages: readonly Message[], model: string): boolean {
  return contextFill(messages).source === 'usage' && contextFill(messages, model).source === 'estimate'
}

function withoutSkillsList(rows: Message[]): Message[] {
  return rows.flatMap((row): Message[] => {
    if (row.type !== 'attachment') return [row]
    const attachment = row.attachment
    if (attachment.type === 'skill_listing') return []
    if (attachment.type !== 'context_capsule' || attachment.sections === undefined) return [row]
    return [{ ...row, attachment: { ...attachment, sections: attachment.sections.filter(section => !section.kinds.includes('skill_listing')) } }]
  })
}

export function contextAfterFold(context: number, before: number, after: number): number {
  const saved = before - after
  return saved < context ? context - saved : Math.floor((context * after) / before)
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
