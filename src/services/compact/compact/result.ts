import type { ToolUseContext } from '../../../Tool.js'
import type { NonNullableUsage } from '../../../utils/api/emptyUsage.js'
import type { AttachmentMessage, Message, SystemCompactBoundaryMessage, UserMessage, CompactMetadata } from '../../../types/message.js'
import type { UUID } from 'node:crypto'
import { foldedTurnReceipts } from '../../../utils/cockpit/turnReceipt.js'
import { collectAwayWork } from '../../../utils/cockpit/awaySummary.js'
import { getMercuryTempDir } from '../../../utils/permissions/filesystem.js'
import { defersUnderLaw } from '../../providers/toolEconomy.js'

export type CompactionResult = {
  boundaryMarker: SystemCompactBoundaryMessage
  operatorMessages?: AttachmentMessage
  summaryMessages: UserMessage[]
  messagesToKeep?: Message[]
  attachments: AttachmentMessage[]
  hookResults: Message[]
  preCompactTokenCount: number
  postCompactTokenCount: number
  truePostCompactTokenCount?: number
  compactionUsage?: NonNullableUsage
  notes?: string[]
}

export type RecompactionInfo = {
  isRecompaction: boolean
  turnsSincePreviousCompact: number
  autoCompactThreshold: number
  previousCompactTurnId?: string
  querySource?: string
  restoreFiles?: boolean
  mustShrink?: boolean
}


export function foldDefersNow(context: ToolUseContext): (name: string) => boolean {
  const model = context.options.engineModel
  return name => {
    const tool = context.options.tools.find(candidate => candidate.name === name)
    return tool !== undefined && defersUnderLaw(tool, model)
  }
}

export function buildPostCompactMessages(result: CompactionResult): Message[] {
  const { boundaryMarker, operatorMessages, summaryMessages, messagesToKeep, attachments, hookResults } = result
  return [
    boundaryMarker,
    ...(operatorMessages !== undefined ? [operatorMessages] : []),
    ...summaryMessages,
    ...(messagesToKeep ?? []),
    ...attachments,
    ...hookResults,
  ]
}

export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: Message[],
): SystemCompactBoundaryMessage {
  if (messagesToKeep.length === 0) return boundary
  const head = messagesToKeep[0]
  const tail = messagesToKeep[messagesToKeep.length - 1]
  if (head !== undefined && tail !== undefined) {
    boundary.compactMetadata.preservedSegment = {
      headUuid: head.uuid,
      anchorUuid,
      tailUuid: tail.uuid,
    }
  }
  return boundary
}

export function foldedWorkOf(messages: Message[], kept: Message[], summaryUuid: UUID): NonNullable<CompactMetadata['work']> {
  return {
    receipts: foldedTurnReceipts(messages, kept, summaryUuid, getMercuryTempDir()),
    recap: collectAwayWork(messages, new Set(kept.map(message => message.uuid))),
  }
}

export function annotateBoundaryWithWork(
  boundary: SystemCompactBoundaryMessage,
  messages: Message[],
  kept: Message[],
  summaryUuid: UUID,
): void {
  boundary.compactMetadata.work = foldedWorkOf(messages, kept, summaryUuid)
}
