
import { randomUUID, type UUID } from 'node:crypto'
import type { ContentBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { BatchedPrompt } from '../../types/textInputTypes.js'
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
  batchTail?: BatchedPrompt[],
): { messages: Message[]; shouldQuery: boolean } {
  const promptUuid = uuid ?? (randomUUID() as UUID)

  let content: string | ContentBlockParam[]
  if (imageContentBlocks.length > 0) {
    if (typeof input === 'string') {
      content = [
        ...(input.trim() !== ''
          ? [{ type: 'text', text: input } as ContentBlockParam]
          : []),
        ...imageContentBlocks,
      ]
    } else {
      content = [...input, ...imageContentBlocks]
    }
  } else {
    content = input
  }

  const message = createUserMessage({
    content,
    uuid: promptUuid,
    ...(imagePasteIds.length > 0 ? { imagePasteIds } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(isMeta === true ? { isMeta: true as const } : {}),
    ...(batchUuids !== undefined ? { batchUuids } : {}),
  })
  const tail = (batchTail ?? []).map(entry =>
    createUserMessage({
      content: entry.value,
      ...(entry.uuid !== undefined ? { uuid: entry.uuid } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(isMeta === true ? { isMeta: true as const } : {}),
    }),
  )
  return { messages: [message, ...tail, ...attachmentMessages], shouldQuery: true }
}
