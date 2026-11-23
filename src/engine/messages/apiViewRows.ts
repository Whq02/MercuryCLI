import type { ContentBlockParam, ToolResultBlockParam } from '../message-shapes/wire.js'
import type { AttachmentMessage, Message, SystemLocalCommandMessage, UserMessage } from '../message-shapes/message.js'
import { STRIPPED_ADMISSION_RECORD_TEXT } from '../../tools/kit/names/toolSearch.js'
import { isToolReferenceBlock } from './toolSearch.js'

type ResultItem = Exclude<ToolResultBlockParam['content'], string | undefined>[number]
type ReferencePolicy = (item: ResultItem) => boolean

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
  return projectReferences(
    message,
    item =>
      isToolReferenceBlock(item) &&
      item.type === 'tool_reference' &&
      typeof item.tool_name === 'string' &&
      item.tool_name.length > 0 &&
      !availableToolNames.has(item.tool_name),
    { type: 'text', text: '[Tool references removed - tools no longer available]' },
  )
}

export function withToolReferenceTurnBoundary(message: UserMessage): UserMessage {
  const blocks = message.message.content
  if (!Array.isArray(blocks)) return message
  const boundary = 'Tool loaded.'
  if (blocks.some(block => block.type === 'text' && block.text.startsWith(boundary))) return message
  if (!blocks.some(block => resultArray(block) && block.content.some(isToolReferenceBlock))) return message
  return {
    ...message,
    message: {
      ...message.message,
      content: [...blocks, { type: 'text', text: boundary }],
    },
  }
}

export function isSystemLocalCommandMessage(message: Message): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

function isAttachmentAnchor(message: Message): boolean {
  if (message.type === 'assistant') return true
  if (message.type !== 'user' || !Array.isArray(message.message.content)) return false
  return message.message.content[0]?.type === 'tool_result'
}

export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  const result: Message[] = []
  let attachments: AttachmentMessage[] = []
  let rest: Message[] = []
  for (const message of messages) {
    if (isAttachmentAnchor(message)) {
      result.push(...attachments, ...rest, message)
      attachments = []
      rest = []
    } else if (message.type === 'attachment') {
      attachments.push(message)
    } else {
      rest.push(message)
    }
  }
  result.push(...attachments, ...rest)
  return result
}
