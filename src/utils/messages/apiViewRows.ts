import type { ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message, SystemLocalCommandMessage, UserMessage } from '../../types/message.js'
import { STRIPPED_ADMISSION_RECORD_TEXT } from '../../constants/tools/toolSearch.js'
import { isToolReferenceBlock } from '../toolSearch.js'

type ResultItem = Extract<ToolResultBlockParam['content'], readonly unknown[]>[number]
type ReferencePolicy = (item: ResultItem) => boolean
const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

function resultArray(block: ContentBlockParam): block is ToolResultBlockParam & { content: ResultItem[] } {
  return block.type === 'tool_result' && Array.isArray(block.content)
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
  return projectReferences(message, isToolReferenceBlock, { type: 'text', text: STRIPPED_ADMISSION_RECORD_TEXT })
}

export function stripUnavailableToolReferencesFromUserMessage(message: UserMessage, availableToolNames: Set<string>): UserMessage {
  const unavailable: ReferencePolicy = item => {
    if (!isToolReferenceBlock(item)) return false
    const name = (item as { tool_name?: string }).tool_name
    return Boolean(name) && !availableToolNames.has(name!)
  }
  return projectReferences(message, unavailable, { type: 'text', text: '[Tool references removed - tools no longer available]' })
}

export function withToolReferenceTurnBoundary(message: UserMessage): UserMessage {
  const blocks = message.message.content
  if (!Array.isArray(blocks)) return message
  const hasBoundary = blocks.some(block => block.type === 'text' && block.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY))
  if (hasBoundary) return message
  const hasReference = blocks.some(block => resultArray(block) && block.content.some(isToolReferenceBlock))
  return !hasReference ? message : {
    ...message, message: { ...message.message, content: [...blocks, { type: 'text', text: TOOL_REFERENCE_TURN_BOUNDARY }] },
  }
}

export function isSystemLocalCommandMessage(message: Message): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

const anchorsAttachments = (message: Message): boolean =>
  message.type === 'assistant' ||
  (message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'tool_result')

export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  const ordered: Message[] = []
  let lifted: AttachmentMessage[] = []
  let rest: Message[] = []
  const closeSegment = (): void => {
    for (const attachment of lifted) ordered.push(attachment)
    for (const message of rest) ordered.push(message)
    lifted = []
    rest = []
  }
  for (const message of messages) {
    if (message.type === 'attachment') {
      lifted.push(message)
    } else if (anchorsAttachments(message)) {
      closeSegment()
      ordered.push(message)
    } else {
      rest.push(message)
    }
  }
  closeSegment()
  return ordered
}
