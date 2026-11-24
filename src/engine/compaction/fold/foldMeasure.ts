import type { AttachmentMessage, Message } from '../../message-shapes/message.js'
import { getTranscriptPath } from '../../../sessions/transcripts/paths.js'
import { contextFill } from '../../context-window/contextTokenCount.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { estimateRequestGauge, readRequestGauge } from '../../run/requestGauge.js'
import { renderFoldLedger, type FoldLedger } from '../foldLedger.js'
import { estimateContextTokens } from '../pruneToolResults.js'
import { getFoldUserSummaryMessage } from '../summariserPrompt.js'
import { buildPostFoldMessages, type FoldResult } from './foldResult.js'

type FoldMeter = {
  gauge: ReturnType<typeof readRequestGauge>
  context: number
  before: number
  count: (rows: Message[]) => number
  measureResult: (result: FoldResult) => number
  after: (landed: number) => { tokens: number; estimate: number }
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
  const measureResult = (result: FoldResult): number => count(buildPostFoldMessages(result))
  return { gauge, context, count, measureResult, ...foldSizes(messages, model, context, count) }
}

export function foldSizes(
  messages: Message[],
  model: string | undefined,
  context: number,
  count: (rows: Message[]) => number,
): { before: number; after: (landed: number) => { tokens: number; estimate: number } } {
  const standing = stripThinkingFromIndex(messages, 0)
  const whole = count(standing)
  const before = count(withoutSkillsList(standing))
  const reading = contextFill(messages, model).source === 'usage' ? context : Math.min(context, whole)
  return { before, after: landed => ({ tokens: contextAfterFold(reading, before, landed), estimate: landed + whole - before }) }
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

function contextAfterFold(context: number, before: number, after: number): number {
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
    getFoldUserSummaryMessage(
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
