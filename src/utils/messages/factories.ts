
import type { ApiUsage as Usage, ContentBlock, ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { randomUUID, type UUID } from 'crypto'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import type { Progress } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
  MessageOrigin,
  PartialCompactDirection,
  ProgressMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NO_RESPONSE_REQUESTED,
  REJECT_MESSAGE,
  turnCutLine,
  turnCutOf,
} from './rejectionText.js'


export const SYNTHETIC_MODEL = '<synthetic>'

export const SYNTHETIC_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

export function isSyntheticMessage(message: Message): boolean {
  if (
    message.type === 'progress' ||
    message.type === 'attachment' ||
    message.type === 'system'
  ) {
    return false
  }
  const content = message.message.content
  return (
    Array.isArray(content) &&
    content[0]?.type === 'text' &&
    SYNTHETIC_MESSAGES.has(content[0].text)
  )
}

export function isSyntheticApiErrorMessage(
  message: Message,
): message is AssistantMessage & { isApiErrorMessage: true } {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    message.message.model === SYNTHETIC_MODEL
  )
}


const ZERO_USAGE = (): Usage =>
  ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  }) as Usage

function fabricateAssistantMessage({
  content,
  isApiErrorMessage = false,
  apiError,
  error,
  errorDetails,
  overflowSignal,
  isVirtual,
  usage = ZERO_USAGE(),
}: {
  content: ContentBlock[]
  isApiErrorMessage?: boolean
  apiError?: AssistantMessage['apiError']
  error?: SDKAssistantMessageError
  errorDetails?: string
  overflowSignal?: AssistantMessage['overflowSignal']
  isVirtual?: true
  usage?: Usage
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      container: null,
      model: SYNTHETIC_MODEL,
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage,
      content,
      context_management: null,
    },
    requestId: undefined,
    apiError,
    error,
    errorDetails,
    ...(overflowSignal !== undefined ? { overflowSignal } : {}),
    isApiErrorMessage,
    isVirtual,
  }
}

export function createAssistantMessage({
  content,
  usage,
  isVirtual,
}: {
  content: string | ContentBlock[]
  usage?: Usage
  isVirtual?: true
}): AssistantMessage {
  const blocks =
    typeof content === 'string'
      ? [
          {
            type: 'text' as const,
            text: content === '' ? NO_CONTENT_MESSAGE : content,
          } as ContentBlock,
        ]
      : content
  return fabricateAssistantMessage({ content: blocks, usage, isVirtual })
}

export function createAssistantAPIErrorMessage({
  content,
  apiError,
  error,
  errorDetails,
  overflow,
}: {
  content: string
  apiError?: AssistantMessage['apiError']
  error?: SDKAssistantMessageError
  errorDetails?: string
  overflow?: AssistantMessage['overflowSignal'] | null
}): AssistantMessage {
  return fabricateAssistantMessage({
    content: [
      {
        type: 'text' as const,
        text: content === '' ? NO_CONTENT_MESSAGE : content,
      } as ContentBlock,
    ],
    isApiErrorMessage: true,
    apiError,
    error,
    errorDetails,
    ...(overflow !== undefined && overflow !== null ? { overflowSignal: overflow } : {}),
  })
}


export function createUserMessage({
  content,
  isMeta,
  isVisibleInTranscriptOnly,
  isVirtual,
  isCompactSummary,
  summarizeMetadata,
  toolUseResult,
  mcpMeta,
  uuid,
  timestamp,
  imagePasteIds,
  sourceToolAssistantUUID,
  permissionMode,
  origin,
  batchUuids,
}: {
  content: string | ContentBlockParam[]
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  uuid?: UUID | string
  timestamp?: string
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  origin?: MessageOrigin
  batchUuids?: string[]
}): UserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: content || NO_CONTENT_MESSAGE,
    },
    isMeta,
    isVisibleInTranscriptOnly,
    isVirtual,
    isCompactSummary,
    summarizeMetadata,
    uuid: (uuid as UUID | undefined) || randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
    toolUseResult,
    mcpMeta,
    imagePasteIds,
    ...(batchUuids !== undefined && batchUuids.length > 0 ? { batchUuids } : {}),
    sourceToolAssistantUUID,
    permissionMode,
    origin,
  }
}

export function prepareUserContent({
  inputString,
  precedingInputBlocks,
}: {
  inputString: string
  precedingInputBlocks: ContentBlockParam[]
}): string | ContentBlockParam[] {
  if (precedingInputBlocks.length === 0) return inputString
  return [...precedingInputBlocks, { text: inputString, type: 'text' }]
}

export function createUserInterruptionMessage({
  toolUse = false,
  reason,
}: {
  toolUse?: boolean
  reason?: unknown
}): UserMessage {
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: turnCutLine(turnCutOf(reason), toolUse),
      },
    ],
  })
}

export function createSyntheticUserCaveatMessage(): UserMessage {
  return createUserMessage({
    content: `<${LOCAL_COMMAND_CAVEAT_TAG}>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</${LOCAL_COMMAND_CAVEAT_TAG}>`,
    isMeta: true,
  })
}

export function formatCommandInputTags(
  commandName: string,
  args: string,
): string {
  return `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>`
}

export function createModelSwitchBreadcrumbs(
  modelArg: string,
  resolvedDisplay: string,
): UserMessage[] {
  return [
    createSyntheticUserCaveatMessage(),
    createUserMessage({ content: formatCommandInputTags('model', modelArg) }),
    createUserMessage({
      content: `<${LOCAL_COMMAND_STDOUT_TAG}>Set model to ${resolvedDisplay}</${LOCAL_COMMAND_STDOUT_TAG}>`,
    }),
  ]
}


export function createProgressMessage<P extends Progress>({
  toolUseID,
  parentToolUseID,
  data,
}: {
  toolUseID: string
  parentToolUseID: string
  data: P
}): ProgressMessage<P> {
  return {
    type: 'progress',
    data,
    toolUseID,
    parentToolUseID,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

export function createToolResultStopMessage(
  toolUseID: string,
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}
