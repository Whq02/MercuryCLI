import type { SystemPruneBoundaryMessage } from '../../src/engine/message-shapes/message.js'
import { MESSAGE_STAMPER } from '../../src/engine/rows/project.js'

export function createPruneBoundaryMessage(
  trigger: 'auto',
  preTokens: number,
  tokensSaved: number,
  compactedToolIds: string[],
  clearedAttachmentUUIDs: string[],
): SystemPruneBoundaryMessage {
  const microcompactMetadata = { trigger, preTokens, tokensSaved, compactedToolIds, clearedAttachmentUUIDs }
  return Object.assign(
    { type: 'system' as const, subtype: 'microcompact_boundary' as const },
    { microcompactMetadata, level: 'info' as const, content: 'Context microcompacted' },
    MESSAGE_STAMPER.mint(),
    { isMeta: false as const },
  )
}
