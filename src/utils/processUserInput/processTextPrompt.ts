// ============================================================================
//  The plain-prompt path: mint a prompt id and assemble the user message,
//  folding in pasted images when present. Always asks to query.
// ============================================================================

import { randomUUID, type UUID } from 'node:crypto'
import type { ContentBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message } from '../../types/message.js'
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
): { messages: Message[]; shouldQuery: boolean } {
  // A fresh prompt id is minted when the caller supplied none.
  const promptUuid = uuid ?? (randomUUID() as UUID)

  // With pasted image blocks the content is the leading text followed by
  // the image blocks: a STRING input contributes a single text block only
  // when it is not blank; a BLOCK-ARRAY input rides whole (no emptiness
  // filter, no re-wrapping). Without pasted images the input is the content
  // directly.
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
  })
  return { messages: [message, ...attachmentMessages], shouldQuery: true }
}
