import { randomUUID, type UUID } from 'node:crypto'
import type { ContentBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message, MessageOrigin } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { createUserMessage } from '../messages.js'

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
  let content: string | ContentBlockParam[]
  if (imageContentBlocks.length === 0) {
    content = input
  } else if (Array.isArray(input)) {
    content = [...input, ...imageContentBlocks]
  } else if (input.trim().length > 0) {
    content = [{ type: 'text', text: input }, ...imageContentBlocks]
  } else {
    content = [...imageContentBlocks]
  }

  const userMessage = createUserMessage({
    content,
    uuid: uuid ?? randomUUID(),
    ...(imagePasteIds.length > 0 ? { imagePasteIds } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(isMeta === true ? { isMeta: true } : {}),
    ...(batchUuids !== undefined ? { batchUuids } : {}),
    ...(origin !== undefined ? { origin } : {}),
  })

  return {
    messages: [userMessage, ...attachmentMessages],
    shouldQuery: true,
  }
}
