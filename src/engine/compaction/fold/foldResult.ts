import type { ToolUseContext } from '../../../tools/kit/tool.js'
import type { NonNullableUsage } from '../../request-parts/emptyUsage.js'
import type { AttachmentMessage, Message, SystemFoldBoundaryMessage, UserMessage, FoldMetadata } from '../../message-shapes/message.js'
import type { UUID } from 'node:crypto'
import { foldedTurnReceipts } from '../../../screen/cockpit/turnReceipt.js'
import { collectAwayWork } from '../../../screen/cockpit/awaySummary.js'
import { getMercuryTempDir } from '../../../permissions/rules/filesystem.js'
import { defersUnderLaw } from '../../../models/roads/toolEconomy.js'

export type FoldResult = {
  boundaryMarker: SystemFoldBoundaryMessage
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

export type RefoldInfo = {
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

export function buildPostFoldMessages(result: FoldResult): Message[] {
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
  boundary: SystemFoldBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: Message[],
): SystemFoldBoundaryMessage {
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

export function foldedWorkOf(messages: Message[], kept: Message[], summaryUuid: UUID): NonNullable<FoldMetadata['work']> {
  return {
    receipts: foldedTurnReceipts(messages, kept, summaryUuid, getMercuryTempDir()),
    recap: collectAwayWork(messages, new Set(kept.map(message => message.uuid))),
  }
}

export function annotateBoundaryWithWork(
  boundary: SystemFoldBoundaryMessage,
  messages: Message[],
  kept: Message[],
  summaryUuid: UUID,
): void {
  boundary.compactMetadata.work = foldedWorkOf(messages, kept, summaryUuid)
}
