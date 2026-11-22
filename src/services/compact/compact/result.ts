import type { ToolUseContext } from '../../../Tool.js'
import type { NonNullableUsage } from '../../../utils/api/emptyUsage.js'
import type { AttachmentMessage, Message, SystemCompactBoundaryMessage, UserMessage, CompactMetadata } from '../../../types/message.js'
import type { UUID } from 'node:crypto'
import { foldedTurnReceipts } from '../../../utils/cockpit/turnReceipt.js'
import { collectAwayWork } from '../../../utils/cockpit/awaySummary.js'
import { getMercuryTempDir } from '../../../utils/permissions/filesystem.js'
import { defersUnderLaw } from '../../providers/toolEconomy.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

export type CompactionResult = Unbuilt

export type RecompactionInfo = Unbuilt


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
  return notBuilt('src/services/compact/compact/result.ts:55')
}

export function foldedWorkOf(messages: Message[], kept: Message[], summaryUuid: UUID): NonNullable<CompactMetadata['work']> {
  return notBuilt('src/services/compact/compact/result.ts:71')
}

export function annotateBoundaryWithWork(
  boundary: SystemCompactBoundaryMessage,
  messages: Message[],
  kept: Message[],
  summaryUuid: UUID,
): void {
  return notBuilt('src/services/compact/compact/result.ts:78')
}
