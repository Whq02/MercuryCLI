import type { UUID } from 'node:crypto'
import type { ContentBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message, MessageOrigin } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { notBuilt } from '../../pi/holes.js'

export function processTextPrompt(
  input: string | ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  imagePasteIds: number[],
  attachmentMessages: AttachmentMessage[],
  uuid?: UUID,
  permissionMode?: PermissionMode,
  isMeta?: boolean,
  batchUuids?: string[],
  origin?: MessageOrigin,
): { messages: Message[]; shouldQuery: boolean } {
  return notBuilt('src/services/processUserInput/processTextPrompt.ts:8')
}
