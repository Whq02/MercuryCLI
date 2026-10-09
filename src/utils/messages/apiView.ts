
import type { ContentBlock, ContentBlockParam, ApiMessage } from '../../types/wire.js'
import isObject from 'lodash-es/isObject.js'
import {
  findToolByName,
  type Tools,
} from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
import { normalizeToolInput } from '../api.js'
import { contentBlocksOf } from './normalize.js'
import { STRIPPED_ADMISSION_RECORD_TEXT } from '../../tools/ToolSearchTool/prompt.js'
import { logForDebugging } from '../debug.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import {
  isToolReferenceBlock,
} from '../toolSearch.js'
import { requestConversationPlan } from './apiPlan.js'

const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

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

export function isSystemLocalCommandMessage(
  message: Message,
): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

export function stripUnavailableToolReferencesFromUserMessage(
  message: UserMessage,
  availableToolNames: Set<string>,
): UserMessage {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message
  }

  const hasUnavailableReference = content.some(
    block =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(c => {
        if (!isToolReferenceBlock(c)) return false
        const toolName = (c as { tool_name?: string }).tool_name
        return (
          toolName && !availableToolNames.has(toolName)
        )
      }),
  )

  if (!hasUnavailableReference) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: content.map(block => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
          return block
        }

        const filteredContent = block.content.filter(c => {
          if (!isToolReferenceBlock(c)) return true
          const toolName = (c as { tool_name?: string }).tool_name
          return !toolName || availableToolNames.has(toolName)
        })

        if (filteredContent.length === 0) {
          return {
            ...block,
            content: [
              {
                type: 'text' as const,
                text: '[Tool references removed - tools no longer available]',
              },
            ],
          }
        }

        return {
          ...block,
          content: filteredContent,
        }
      }),
    },
  }
}


export function stripToolReferenceBlocksFromUserMessage(
  message: UserMessage,
): UserMessage {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message
  }

  const hasToolReference = content.some(
    block =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(isToolReferenceBlock),
  )

  if (!hasToolReference) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: content.map(block => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
          return block
        }

        const filteredContent = block.content.filter(
          c => !isToolReferenceBlock(c),
        )

        if (filteredContent.length === 0) {
          return {
            ...block,
            content: [
              {
                type: 'text' as const,
                text: STRIPPED_ADMISSION_RECORD_TEXT,
              },
            ],
          }
        }

        return {
          ...block,
          content: filteredContent,
        }
      }),
    },
  }
}

const wireToolUse = (block: Extract<ContentBlock, { type: 'tool_use' }>) => ({
  type: 'tool_use' as const,
  id: block.id,
  name: block.name,
  input: block.input,
})

export function stripCallerFieldFromAssistantMessage(
  message: AssistantMessage,
): AssistantMessage {
  const carriesCaller = (block: ContentBlock): boolean =>
    block.type === 'tool_use' && 'caller' in block && block.caller !== null
  if (!message.message.content.some(carriesCaller)) return message
  const content = message.message.content.map(block =>
    block.type === 'tool_use' ? wireToolUse(block) : block,
  )
  return { ...message, message: { ...message.message, content } }
}

function contentHasToolReference(
  content: ReadonlyArray<ContentBlockParam>,
): boolean {
  return content.some(
    block =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(isToolReferenceBlock),
  )
}


export function withToolReferenceTurnBoundary(message: UserMessage): UserMessage {
  const content = message.message.content
  if (
    !Array.isArray(content) ||
    content.some(block => block.type === 'text' && block.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY)) ||
    !contentHasToolReference(content)
  ) return message
  return {
    ...message,
    message: {
      ...message.message,
      content: [...content, { type: 'text', text: TOOL_REFERENCE_TURN_BOUNDARY }],
    },
  }
}

export function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tools = [],
): (UserMessage | AssistantMessage)[] {
  return requestConversationPlan(messages, tools).messages
}


export function normalizeContentFromAPI(
  contentBlocks: ApiMessage['content'],
  tools: Tools,
): ApiMessage['content'] {
  if (!contentBlocks) {
    return []
  }
  if (contentBlocks.some(b => b == null)) {
    logForDebugging(
      'normalizeContentFromAPI: dropping null content block(s) from a provider response — not a decodable block shape',
      { level: 'warn' },
    )
    contentBlocks = contentBlocks.filter(b => b != null)
  }
  return (contentBlocksOf(contentBlocks) as ApiMessage['content']).map(contentBlock => {
    switch (contentBlock.type) {
      case 'tool_use': {
        if (
          typeof contentBlock.input !== 'string' &&
          !isObject(contentBlock.input)
        ) {
          throw new Error('Tool use input must be a string or object')
        }

        let normalizedInput: unknown
        if (typeof contentBlock.input === 'string') {
          const parsed = safeParseJSON(contentBlock.input)
          if (parsed === null && contentBlock.input.length > 0) {
            logForDebugging(
              `normalizeContentFromAPI: streamed tool_use input for ${contentBlock.name} failed to parse (${contentBlock.input.length} chars); using empty input`,
              { level: 'error' },
            )
          }
          normalizedInput = parsed ?? {}
        } else {
          normalizedInput = contentBlock.input
        }

        if (typeof normalizedInput === 'object' && normalizedInput !== null) {
          const tool = findToolByName(tools, contentBlock.name)
          if (tool) {
            try {
              normalizedInput = normalizeToolInput(
                tool,
                normalizedInput as { [key: string]: unknown },
              )
            } catch (error) {
              logError(new Error('Error normalizing tool input: ' + error))
            }
          }
        }

        return {
          ...contentBlock,
          input: normalizedInput,
        }
      }
      case 'text':
        return contentBlock
      case 'code_execution_tool_result':
      case 'mcp_tool_use':
      case 'mcp_tool_result':
      case 'container_upload':
        return contentBlock
      case 'server_tool_use':
        if (typeof contentBlock.input === 'string') {
          return {
            ...contentBlock,
            input: (safeParseJSON(contentBlock.input) ?? {}) as {
              [key: string]: unknown
            },
          }
        }
        return contentBlock
      default:
        return contentBlock
    }
  })
}
