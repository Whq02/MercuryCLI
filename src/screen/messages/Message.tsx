import React, { memo } from 'react'
import { Box } from '../themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import type {
  AssistantMessage,
  NormalizedMessage,
  ProgressMessage,
  RenderableMessage,
} from '../../engine/message-shapes/message.js'
import type { Tools } from '../../tools/kit/tool.js'
import type { Command } from '../../commands/catalogue/commands.js'
import type { MessageLookups } from '../../engine/messages/lookups.js'
import { AssistantRedactedThinkingMessage } from './AssistantRedactedThinkingMessage.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'
import { AttachmentMessage } from './AttachmentMessage.js'
import { CollapsedReadSearchContent } from './CollapsedReadSearchContent.js'
import { FoldBoundaryMessage } from './FoldBoundaryMessage.js'
import { CrewChatRow } from './CrewChatRow.js'
import { FoldSummary } from './FoldSummary.js'
import { ExpandShellOutputProvider } from '../shell-output/ExpandShellOutputContext.js'
import { GroupedToolUseContent } from './GroupedToolUseContent.js'
import { MessageMetaProvider, ReplyAddress, replyAddressLine } from './TranscriptNameplate.js'
import { SystemTextMessage } from './SystemTextMessage.js'
import { TurnReceiptRow } from './TurnReceiptRow.js'
import { UserImageMessage } from './UserImageMessage.js'
import { UserTextMessage } from './UserTextMessage.js'
import { UserToolResultMessage } from './user-tool-result/UserToolResultMessage.js'
import { MessageModel } from './MessageModel.js'
import { MessageTimestamp } from './MessageTimestamp.js'
import { SYNTHETIC_MODEL } from '../../engine/message-shapes/factories.js'
import { imageRowNumbersOf } from '../../engine/message-shapes/normalize.js'

type Props = {
  message: RenderableMessage | AssistantMessage
  messages?: readonly (RenderableMessage | NormalizedMessage)[]
  tools: Tools
  commands?: readonly Command[]
  verbose: boolean
  addMargin: boolean
  shouldAnimate: boolean
  shouldShowDot: boolean
  inProgressToolUseIDs: Set<string>
  streamingToolUseIDs?: Set<string>
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  width?: number | string
  isTranscriptMode: boolean
  isStatic: boolean
  isLatestShellOutput?: boolean
  lastThinkingBlockId?: string | null
  hasContentAfter?: boolean
  isActiveGroup?: boolean
  streamFaultRecovered?: boolean
  lookups: MessageLookups
}

function hasThinkingContent(m: RenderableMessage | AssistantMessage): boolean {
  if (m.type !== 'assistant') return false
  const content = m.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

function displayMessageOf(message: RenderableMessage | AssistantMessage): NormalizedMessage | AssistantMessage | null {
  if (message.type === 'grouped_tool_use') {
    return (message as { displayMessage?: NormalizedMessage }).displayMessage ?? null
  }
  if (message.type === 'collapsed_read_search') {
    return (message as { displayMessage?: NormalizedMessage }).displayMessage ?? null
  }
  return message as NormalizedMessage | AssistantMessage
}

function renderSystemBody(
  message: Extract<RenderableMessage, { type: 'system' }>,
  props: Props,
): React.ReactNode {
  if (message.subtype === 'compact_boundary') {
    const landingRow = props.messages?.find(
      m => m.type === 'assistant' && m.foldLanding?.boundaryId === message.uuid,
    )
    const landing =
      landingRow && landingRow.type === 'assistant' && landingRow.foldLanding
        ? landingRow.foldLanding.usage
        : undefined
    return <FoldBoundaryMessage message={message} landing={landing} />
  }
  if (message.subtype === 'microcompact_boundary') {
    return null
  }
  if (message.subtype === 'crew_chat') {
    return <CrewChatRow message={message} />
  }
  if (message.subtype === 'local_command') {
    return (
      <UserTextMessage
        addMargin={props.addMargin}
        param={{ type: 'text', text: message.content ?? '' }}
        verbose={props.verbose}
        isTranscriptMode={props.isTranscriptMode}
      />
    )
  }
  return (
    <SystemTextMessage
      message={message}
      addMargin={props.addMargin}
      verbose={props.verbose}
      isTranscriptMode={props.isTranscriptMode}
    />
  )
}

function renderAssistantBody(
  message: Extract<RenderableMessage | AssistantMessage, { type: 'assistant' }>,
  props: Props,
  showReplyAddress: boolean,
): React.ReactNode {
  const content = message.message.content
  if (!Array.isArray(content)) return null

  const parsedTs = message.timestamp ? Date.parse(message.timestamp) : Number.NaN
  const startedAtMs = Number.isFinite(parsedTs) ? parsedTs : null
  const recovered =
    (props.streamFaultRecovered ?? false) ||
    props.lookups.recoveredStreamFaultUuids.has(message.uuid)
  const lastThinkingId = props.lastThinkingBlockId ?? null

  const rendered: React.ReactNode[] = []
  for (let index = 0; index < content.length; index++) {
    const block = content[index]!
    if (block.type === 'tool_use') {
      rendered.push(
        <AssistantToolUseMessage
          key={index}
          param={block}
          addMargin={props.addMargin}
          tools={props.tools}
          commands={props.commands}
          verbose={props.verbose}
          inProgressToolUseIDs={props.inProgressToolUseIDs}
          progressMessagesForMessage={props.progressMessagesForMessage}
          shouldAnimate={props.shouldAnimate}
          shouldShowDot={props.shouldShowDot}
          inProgressToolCallCount={props.inProgressToolUseIDs.size}
          lookups={props.lookups}
          isTranscriptMode={props.isTranscriptMode}
          startedAtMs={startedAtMs}
        />,
      )
    } else if (block.type === 'text') {
      rendered.push(
        <AssistantTextMessage
          key={index}
          param={block}
          addMargin={showReplyAddress ? false : props.addMargin}
          shouldShowDot={props.shouldShowDot}
          verbose={props.verbose}
          streamFaultRecovered={recovered}
          width={props.width}
        />,
      )
    } else if (block.type === 'redacted_thinking') {
      if (props.verbose || props.isTranscriptMode) {
        rendered.push(
          <AssistantRedactedThinkingMessage key={index} addMargin={props.addMargin} />,
        )
      }
    } else if (block.type === 'thinking') {
      const hideInTranscript =
        lastThinkingId !== null && lastThinkingId !== `${message.uuid}:${index}`
      rendered.push(
        <AssistantThinkingMessage
          key={index}
          param={block}
          addMargin={props.addMargin}
          verbose={props.verbose}
          isTranscriptMode={props.isTranscriptMode}
          hideInTranscript={hideInTranscript}
        />,
      )
    }
  }

  if (rendered.length === 0) return null
  return (
    <Box flexDirection="column" width={props.width ?? '100%'}>
      {rendered}
    </Box>
  )
}

function renderUserBody(
  message: Extract<RenderableMessage, { type: 'user' }>,
  props: Props,
): React.ReactNode {
  if (message.isCompactSummary) {
    return (
      <FoldSummary
        message={message}
        screen={props.isTranscriptMode ? 'transcript' : 'prompt'}
      />
    )
  }

  const rawContent = message.message.content
  const blocks = Array.isArray(rawContent)
    ? rawContent
    : [{ type: 'text' as const, text: String(rawContent) }]

  const imageIds = imageRowNumbersOf(blocks, message.imagePasteIds)
  const toolResultWidth =
    typeof props.width === 'number' ? props.width - 5 : (props.width ?? '100%')

  let imageCounter = 0
  const rendered: React.ReactNode[] = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    if (block.type === 'text') {
      rendered.push(
        <UserTextMessage
          key={index}
          addMargin={props.addMargin}
          param={block}
          verbose={props.verbose}
          isTranscriptMode={props.isTranscriptMode}
          origin={message.origin}
        />,
      )
    } else if (block.type === 'image') {
      const imageId = imageIds[imageCounter++]
      if (imageId === null) continue
      rendered.push(
        <UserImageMessage
          key={index}
          addMargin={!props.isTranscriptMode}
          imageId={imageId}
        />,
      )
    } else if (block.type === 'tool_result') {
      const param: ToolResultBlockParam = block
      rendered.push(
        <UserToolResultMessage
          key={index}
          param={param}
          message={message}
          lookups={props.lookups}
          progressMessagesForMessage={props.progressMessagesForMessage}
          tools={props.tools}
          verbose={props.verbose}
          width={toolResultWidth}
          style={props.style}
          isTranscriptMode={props.isTranscriptMode}
        />,
      )
    }
  }

  if (rendered.length === 0) return null
  const column = (
    <Box flexDirection="column" width={props.width ?? '100%'}>
      {rendered}
    </Box>
  )
  return props.isLatestShellOutput ? (
    <ExpandShellOutputProvider>{column}</ExpandShellOutputProvider>
  ) : (
    column
  )
}

function MessageInner(props: Props): React.ReactNode {
  const {
    message,
    tools,
    verbose,
    addMargin,
    shouldAnimate,
    inProgressToolUseIDs,
    isTranscriptMode,
    isActiveGroup = false,
    lookups,
  } = props

  const assistantHasText =
    message.type === 'assistant' &&
    Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'text')
  const replyMarks = message.type === 'assistant' ? message.inReplyTo : undefined
  const showReplyAddress =
    assistantHasText && replyAddressLine(replyMarks) !== null

  let body: React.ReactNode = null
  if (message.type === 'attachment') {
    body = (
      <AttachmentMessage
        addMargin={addMargin}
        attachment={message.attachment}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    )
  } else if (message.type === 'turn_receipt') {
    body = <TurnReceiptRow message={message} />
  } else if (message.type === 'grouped_tool_use') {
    body = (
      <GroupedToolUseContent
        message={message}
        tools={tools}
        lookups={lookups}
        inProgressToolUseIDs={inProgressToolUseIDs}
        shouldAnimate={shouldAnimate}
      />
    )
  } else if (message.type === 'collapsed_read_search') {
    body = (
      <CollapsedReadSearchContent
        message={message}
        inProgressToolUseIDs={inProgressToolUseIDs}
        shouldAnimate={shouldAnimate}
        verbose={verbose || isTranscriptMode}
        isTranscriptMode={isTranscriptMode}
        tools={tools}
        lookups={lookups}
        isActiveGroup={isActiveGroup}
      />
    )
  } else if (message.type === 'system') {
    body = renderSystemBody(message, props)
  } else if (message.type === 'assistant') {
    body = renderAssistantBody(message, props, showReplyAddress)
  } else if (message.type === 'user') {
    body = renderUserBody(message, props)
  }

  if (body === null) return null

  const displayMessage = displayMessageOf(message)
  const addressedBody = showReplyAddress ? (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <ReplyAddress marks={replyMarks} />
      {body}
    </Box>
  ) : (
    body
  )

  const sourceUuid = message.type === 'user' ? message.sourceUuid : undefined
  const queued =
    (message.type === 'user' || message.type === 'attachment') &&
    message.queued === true
  const heldFor =
    (message.type === 'user' || message.type === 'attachment') &&
    message.heldFor === 'compaction'
      ? ('compaction' as const)
      : undefined
  const metaMessage = {
    uuid: sourceUuid ?? message.uuid,
    type: message.type,
    timestamp: displayMessage?.timestamp,
    ...(queued ? { queued: true as const } : {}),
    ...(heldFor !== undefined ? { heldFor } : {}),
  }

  const wrapped = (
    <MessageMetaProvider message={metaMessage}>{addressedBody}</MessageMetaProvider>
  )

  const displayIsAssistantWithText =
    displayMessage !== null &&
    displayMessage.type === 'assistant' &&
    Array.isArray(displayMessage.message.content) &&
    displayMessage.message.content.some(block => block.type === 'text')
  const displayModel =
    displayMessage !== null && displayMessage.type === 'assistant'
      ? displayMessage.message.model
      : undefined
  const showHeader =
    isTranscriptMode &&
    displayIsAssistantWithText &&
    (Boolean(displayMessage.timestamp) ||
      (typeof displayModel === 'string' &&
        displayModel.length > 0 &&
        displayModel !== SYNTHETIC_MODEL))

  if (showHeader && displayMessage !== null) {
    return (
      <Box flexDirection="column" width="100%" marginTop={1}>
        <Box justifyContent="flex-end" gap={1}>
          <MessageTimestamp
            message={displayMessage as NormalizedMessage}
            isTranscriptMode={isTranscriptMode}
          />
          <MessageModel
            message={displayMessage as NormalizedMessage}
            isTranscriptMode={isTranscriptMode}
          />
        </Box>
        {wrapped}
      </Box>
    )
  }

  return wrapped
}

function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) return false
  const prevQueued =
    (prev.message.type === 'user' || prev.message.type === 'attachment') &&
    prev.message.queued === true
  const nextQueued =
    (next.message.type === 'user' || next.message.type === 'attachment') &&
    next.message.queued === true
  if (prevQueued !== nextQueued) return false
  const prevHeldFor =
    prev.message.type === 'user' || prev.message.type === 'attachment'
      ? prev.message.heldFor
      : undefined
  const nextHeldFor =
    next.message.type === 'user' || next.message.type === 'attachment'
      ? next.message.heldFor
      : undefined
  if (prevHeldFor !== nextHeldFor) return false
  if (
    displayMessageOf(prev.message)?.timestamp !==
    displayMessageOf(next.message)?.timestamp
  ) {
    return false
  }
  if (prev.verbose !== next.verbose) return false
  if ((prev.isLatestShellOutput ?? false) !== (next.isLatestShellOutput ?? false)) {
    return false
  }
  if (prev.isTranscriptMode !== next.isTranscriptMode) return false
  if (prev.width !== next.width) return false
  if (
    (prev.lastThinkingBlockId ?? null) !== (next.lastThinkingBlockId ?? null) &&
    hasThinkingContent(next.message)
  ) {
    return false
  }
  return prev.isStatic && next.isStatic
}

export const Message = memo(MessageInner, areMessagePropsEqual)

export default Message
