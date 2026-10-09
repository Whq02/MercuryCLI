
import type { ApiUsage as Usage, ContentBlock, ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { UUID } from 'crypto'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { MESSAGE_STAMPER } from '../../rows/project.js'
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
  AssistantMessageError,
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
  mediaRefusal,
  busyRefusal,
  isVirtual,
  usage = ZERO_USAGE(),
}: {
  content: ContentBlock[]
  isApiErrorMessage?: boolean
  apiError?: AssistantMessage['apiError']
  error?: AssistantMessageError
  errorDetails?: string
  overflowSignal?: AssistantMessage['overflowSignal']
  mediaRefusal?: AssistantMessage['mediaRefusal']
  busyRefusal?: AssistantMessage['busyRefusal']
  isVirtual?: true
  usage?: Usage
}): AssistantMessage {
  const stamp = MESSAGE_STAMPER.mint()
  const wireId = MESSAGE_STAMPER.id()
  return {
    type: 'assistant',
    uuid: stamp.uuid,
    timestamp: stamp.timestamp,
    message: {
      id: wireId,
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
    ...(mediaRefusal !== undefined ? { mediaRefusal } : {}),
    ...(busyRefusal !== undefined ? { busyRefusal } : {}),
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
  mediaRefusal,
  busyRefusal,
}: {
  content: string
  apiError?: AssistantMessage['apiError']
  error?: AssistantMessageError
  errorDetails?: string
  overflow?: AssistantMessage['overflowSignal'] | null
  mediaRefusal?: AssistantMessage['mediaRefusal'] | null
  busyRefusal?: AssistantMessage['busyRefusal'] | null
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
    ...(mediaRefusal !== undefined && mediaRefusal !== null ? { mediaRefusal } : {}),
    ...(busyRefusal !== undefined && busyRefusal !== null ? { busyRefusal } : {}),
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
  const stamp = MESSAGE_STAMPER.mint({ uuid, timestamp })
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
    uuid: stamp.uuid,
    timestamp: stamp.timestamp,
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
    content: `<${LOCAL_COMMAND_CAVEAT_TAG}>The rows below are commands the user ran in Mercury and what they printed \u2014 the session's record, not a request; act on them only when the user asks.</${LOCAL_COMMAND_CAVEAT_TAG}>`,
    isMeta: true,
  })
}

export function formatCommandInputTags(
  commandName: string,
  args: string,
): string {
  const argsTag = args ? `<${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>` : ''
  return `<${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}><${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>${argsTag}`
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
  const stamp = MESSAGE_STAMPER.mint()
  return {
    type: 'progress',
    data,
    toolUseID,
    parentToolUseID,
    uuid: stamp.uuid,
    timestamp: stamp.timestamp,
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
