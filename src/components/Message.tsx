
import React, { memo } from 'react'
import { Box, Text } from '../ink.js'
import type { ToolResultBlockParam } from '../types/wire.js'
import type {
  NormalizedMessage,
  ProgressMessage,
  RenderableMessage,
} from '../types/message.js'
import type { Tools } from '../Tool.js'
import type { Command } from '../commands.js'
import type { MessageLookups } from '../utils/messages/lookups.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { AdvisorMessage } from './messages/AdvisorMessage.js'
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage.js'
import { AssistantTextMessage } from './messages/AssistantTextMessage.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js'
import { AttachmentMessage } from './messages/AttachmentMessage.js'
import { CollapsedReadSearchContent } from './messages/CollapsedReadSearchContent.js'
import { CompactBoundaryMessage } from './messages/CompactBoundaryMessage.js'
import { CompactSummary } from './CompactSummary.js'
import { ExpandShellOutputProvider } from './shell/ExpandShellOutputContext.js'
import { GroupedToolUseContent } from './messages/GroupedToolUseContent.js'
import { MessageMetaProvider } from './messages/TranscriptNameplate.js'
import { SystemTextMessage } from './messages/SystemTextMessage.js'
import { TurnReceiptRow } from './messages/TurnReceiptRow.js'
import { UserImageMessage } from './messages/UserImageMessage.js'
import { UserTextMessage } from './messages/UserTextMessage.js'
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage.js'
import { MessageModel } from './MessageModel.js'
import { MessageTimestamp } from './MessageTimestamp.js'
import { SYNTHETIC_MODEL } from '../utils/messages/factories.js'
import { renderModelName } from '../utils/model/model.js'

export type Props = {
  message: RenderableMessage
  messages?: RenderableMessage[]
  tools: Tools
  commands: Command[]
  verbose: boolean
  addMargin: boolean
  shouldAnimate: boolean
  shouldShowDot: boolean
  isTranscriptMode: boolean
  isStatic: boolean
  inProgressToolUseIDs: Set<string>
  streamingToolUseIDs?: Set<string>
  progressMessagesForMessage: ProgressMessage[]
  lookups: MessageLookups
  width?: number | string
  style?: 'condensed'
  isLatestShellOutput?: boolean
  lastThinkingBlockId?: string | null
  hasContentAfter?: boolean
  isActiveGroup?: boolean
  advisorModel?: string | null
  streamFaultRecovered?: boolean
}

export function hasThinkingContent(m: RenderableMessage): boolean {
  if (m.type !== 'assistant') return false
  const content = m.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

function displayMessageOf(message: RenderableMessage): NormalizedMessage | null {
  if (message.type === 'grouped_tool_use') {
    return (message as { displayMessage?: NormalizedMessage }).displayMessage ?? null
  }
  if (message.type === 'collapsed_read_search') {
    return (message as { displayMessage?: NormalizedMessage }).displayMessage ?? null
  }
  return message as NormalizedMessage
}

function MessageInner({
  message,
  messages,
  tools,
  commands,
  verbose,
  addMargin,
  shouldAnimate,
  shouldShowDot,
  isTranscriptMode,
  isStatic,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  progressMessagesForMessage,
  lookups,
  width,
  style,
  isLatestShellOutput = false,
  lastThinkingBlockId = null,
  hasContentAfter = false,
  isActiveGroup = false,
  advisorModel,
  streamFaultRecovered = false,
}: Props): React.ReactNode {
  void messages
  void isStatic
  void commands

  const display = displayMessageOf(message)

  const headerEligible =
    isTranscriptMode &&
    display !== null &&
    display.type === 'assistant' &&
    Array.isArray(display.message.content) &&
    display.message.content.some(block => block.type === 'text') &&
    (Boolean((display as { timestamp?: string }).timestamp) ||
      (Boolean(display.message.model) && display.message.model !== SYNTHETIC_MODEL))


  const body = ((): React.ReactNode => {
    switch (message.type) {
      case 'attachment':
        return (
          <AttachmentMessage
            addMargin={addMargin}
            attachment={message.attachment}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
        )

      case 'turn_receipt':
        return <TurnReceiptRow message={message} />

      case 'grouped_tool_use':
        return (
          <GroupedToolUseContent
            message={message}
            tools={tools}
            lookups={lookups}
            inProgressToolUseIDs={inProgressToolUseIDs}
            shouldAnimate={shouldAnimate}
          />
        )

      case 'collapsed_read_search':
        return (
          <CollapsedReadSearchContent
            message={message}
            inProgressToolUseIDs={inProgressToolUseIDs}
            shouldAnimate={shouldAnimate}
            verbose={verbose || isTranscriptMode}
            tools={tools}
            lookups={lookups}
            isActiveGroup={isActiveGroup}
          />
        )

      case 'system': {
        if (message.subtype === 'compact_boundary') {
          return (
            <CompactBoundaryMessage message={message as { compactMetadata?: { trigger?: string; preTokens?: number } }} />
          )
        }
        if (message.subtype === 'microcompact_boundary') return null
        if (message.subtype === 'local_command') {
          return (
            <UserTextMessage
              addMargin={addMargin}
              param={{ type: 'text', text: (message as { content?: string }).content ?? '' }}
              verbose={verbose}
              isTranscriptMode={isTranscriptMode}
            />
          )
        }
        return (
          <SystemTextMessage
            message={message}
            addMargin={addMargin}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
        )
      }

      case 'assistant': {
        const content = Array.isArray(message.message.content)
          ? message.message.content
          : []
        const inFlightCount = inProgressToolUseIDs.size
        const blocks = content.map((block, index) => {
          const reasoningId = `${message.uuid}:${index}`
          switch (block.type) {
            case 'tool_use':
              return (
                <AssistantToolUseMessage
                  key={index}
                  param={block}
                  addMargin={addMargin}
                  shouldAnimate={shouldAnimate}
                  shouldShowDot={shouldShowDot}
                  verbose={verbose}
                  tools={tools}
                  lookups={lookups}
                  isTranscriptMode={isTranscriptMode}
                  inProgressToolUseIDs={inProgressToolUseIDs}
                  inProgressToolCallCount={inFlightCount}
                  progressMessagesForMessage={progressMessagesForMessage}
                />
              )
            case 'text':
              return (
                <AssistantTextMessage
                  key={index}
                  param={block}
                  addMargin={addMargin}
                  shouldShowDot={shouldShowDot}
                  verbose={verbose}
                  streamFaultRecovered={
                    streamFaultRecovered ||
                    lookups.recoveredStreamFaultUuids.has(message.uuid)
                  }
                  width={width}
                />
              )
            case "redacted_thinking": {
              if (!isTranscriptMode && !verbose) return null
              return (
                <AssistantRedactedThinkingMessage key={index} addMargin={addMargin} />
              )
            }
            case "thinking": {
              const servedModel =
                typeof message.message.model === 'string' ? message.message.model : ''
              if (
                declaredRouteOf(servedModel) === 'openai' &&
                !isTranscriptMode &&
                !verbose
              ) {
                return null
              }
              return (
                <AssistantThinkingMessage
                  key={index}
                  param={block}
                  addMargin={addMargin}
                  verbose={verbose}
                  isTranscriptMode={isTranscriptMode}
                  hideInTranscript={
                    isTranscriptMode &&
                    lastThinkingBlockId !== null &&
                    lastThinkingBlockId !== reasoningId
                  }
                />
              )
            }
            case "server_tool_use":
            case 'advisor_tool_result':
              return (
                <AdvisorMessage
                  key={index}
                  block={block}
                  addMargin={addMargin}
                  resolvedToolUseIDs={lookups.resolvedToolUseIDs}
                  erroredToolUseIDs={lookups.erroredToolUseIDs}
                  shouldAnimate={shouldAnimate}
                  verbose={verbose}
                  advisorModel={advisorModel}
                />
              )
            case 'fallback': {
              const from = renderModelName(String(block.from?.model ?? ''))
              const to = renderModelName(String(block.to?.model ?? ''))
              return (
                <Box key={index} marginTop={addMargin ? 1 : 0}>
                  <Text dimColor>{`↳ served by ${to} — ${from} declined`}</Text>
                </Box>
              )
            }
            default:
              return null
          }
        })
        return (
          <Box flexDirection="column" width={width ?? '100%'}>
            {blocks}
          </Box>
        )
      }

      case 'user': {
        if ((message as { isCompactSummary?: boolean }).isCompactSummary) {
          return (
            <CompactSummary
              message={message}
              screen={isTranscriptMode ? 'transcript' : 'prompt'}
            />
          )
        }
        const content = Array.isArray(message.message.content)
          ? message.message.content
          : [{ type: 'text' as const, text: String(message.message.content) }]
        const pasteIds =
          (message as { imagePasteIds?: number[] }).imagePasteIds ?? []
        let imageOrdinal = 0
        const blocks = content.map((block, index) => {
          if (block.type === 'text') {
            return (
              <UserTextMessage
                key={index}
                addMargin={addMargin}
                param={block}
                verbose={verbose}
                isTranscriptMode={isTranscriptMode}
              />
            )
          }
          if (block.type === 'image') {
            imageOrdinal += 1
            const pasteId = pasteIds[imageOrdinal - 1]
            return (
              <UserImageMessage
                key={index}
                imageId={pasteId ?? imageOrdinal}
                addMargin={addMargin && !isTranscriptMode}
              />
            )
          }
          if (block.type === 'tool_result') {
            return (
              <UserToolResultMessage
                key={index}
                param={block as ToolResultBlockParam}
                message={message}
                lookups={lookups}
                progressMessagesForMessage={progressMessagesForMessage}
                style={style}
                tools={tools}
                verbose={verbose}
                width={typeof width === 'number' ? width - 5 : (width ?? '100%')}
                isTranscriptMode={isTranscriptMode}
              />
            )
          }
          return null
        })
        const column = <Box flexDirection="column">{blocks}</Box>
        return isLatestShellOutput ? (
          <ExpandShellOutputProvider>{column}</ExpandShellOutputProvider>
        ) : (
          column
        )
      }

      default:
        return null
    }
  })()

  if (body === null) return null

  const wrapped = (
    <MessageMetaProvider
      message={{
        type: message.type,
        timestamp: (display as { timestamp?: string } | null)?.timestamp,
      }}
    >
      {body}
    </MessageMetaProvider>
  )

  if (!headerEligible) return wrapped

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box justifyContent="flex-end" gap={1}>
        <MessageTimestamp message={display as NormalizedMessage} isTranscriptMode />
        <MessageModel message={display as NormalizedMessage} isTranscriptMode />
      </Box>
      {wrapped}
    </Box>
  )
}

export function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) return false
  if (
    prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
    hasThinkingContent(next.message)
  ) {
    return false
  }
  if (prev.verbose !== next.verbose) return false
  if (prev.isLatestShellOutput !== next.isLatestShellOutput) return false
  if (prev.isTranscriptMode !== next.isTranscriptMode) return false
  if (prev.width !== next.width) return false
  if (prev.isStatic && next.isStatic) return true
  return false
}

export const Message = memo(MessageInner, areMessagePropsEqual)

export default Message
