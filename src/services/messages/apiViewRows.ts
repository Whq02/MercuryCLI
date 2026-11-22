import type { ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message, SystemLocalCommandMessage, UserMessage } from '../../types/message.js'
import { STRIPPED_ADMISSION_RECORD_TEXT } from '../../constants/tools/toolSearch.js'
import { isToolReferenceBlock } from './toolSearch.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ResultItem = Unbuilt
type ReferencePolicy = (...args: Unbuilt[]) => Unbuilt

function resultArray(block: ContentBlockParam): block is ToolResultBlockParam & { content: ResultItem[] } {
  return notBuilt('src/services/messages/apiViewRows.ts:10')
}

function projectReferences(row: UserMessage, remove: ReferencePolicy, empty: ResultItem): UserMessage {
  const blocks = row.message.content
  if (!Array.isArray(blocks) || !blocks.some(block => resultArray(block) && block.content.some(remove))) return row
  const content = blocks.map(block => {
    if (!resultArray(block)) return block
    const kept = block.content.filter(item => !remove(item))
    return { ...block, content: kept.length ? kept : [{ ...empty }] }
  })
  return { ...row, message: { ...row.message, content } }
}

export function stripToolReferenceBlocksFromUserMessage(message: UserMessage): UserMessage {
  return notBuilt('src/services/messages/apiViewRows.ts:25')
}

export function stripUnavailableToolReferencesFromUserMessage(message: UserMessage, availableToolNames: Set<string>): UserMessage {
  return notBuilt('src/services/messages/apiViewRows.ts:29')
}

export function withToolReferenceTurnBoundary(message: UserMessage): UserMessage {
  return notBuilt('src/services/messages/apiViewRows.ts:38')
}

export function isSystemLocalCommandMessage(message: Message): message is SystemLocalCommandMessage {
  return notBuilt('src/services/messages/apiViewRows.ts:49')
}

export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  return notBuilt('src/services/messages/apiViewRows.ts:59')
}
