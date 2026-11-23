import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { Attachment } from '../../engine/attachment-shapes/attachmentTypes.js'
import { formatFileSize } from '../../platform/text/format.js'
import { plural } from '../../platform/text/strings.js'
import { permissionModeTitle } from '../../permissions/rules/permissionMode.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { DiagnosticsDisplay } from './DiagnosticsDisplay.js'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js'
import { UserImageMessage } from './UserImageMessage.js'
import { UserTextMessage } from './UserTextMessage.js'
import { useSelectedMessageBg } from './messageActions.js'

function AttachmentLine({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="wrap">
        {children}
      </Text>
    </MessageResponse>
  )
}

function HookOutputBlock({
  output,
  hookName,
  hookEvent,
  verbose,
}: {
  output: string
  hookName: string
  hookEvent: string
  verbose: boolean
}): React.ReactNode {
  const lines = output.split('\n').filter(line => line !== '')
  return (
    <Box flexDirection="column">
      {lines.length === 0 ? (
        <AttachmentLine>Hook output is in the debug log.</AttachmentLine>
      ) : verbose ? (
        lines.map((line, index) => (
          <Text key={index} dimColor>
            {line}
          </Text>
        ))
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{lines[0]}</Text>
          {lines.length > 1 ? (
            <Text dimColor>
              … +{lines.length - 1} {plural(lines.length - 1, 'line')}{' '}
              <CtrlOToExpand />
            </Text>
          ) : null}
        </Box>
      )}
      <AttachmentLine>
        hook {hookName} · {hookEvent} · /hooks
      </AttachmentLine>
    </Box>
  )
}

export function AttachmentMessage({
  addMargin = false,
  attachment,
  verbose = false,
  isTranscriptMode = false,
}: {
  addMargin?: boolean
  attachment: Attachment
  verbose?: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  const selectedBg = useSelectedMessageBg()

  switch (attachment.type) {
    case 'directory': {
      const dir = attachment.displayPath.endsWith('/')
        ? attachment.displayPath
        : `${attachment.displayPath}/`
      return (
        <AttachmentLine>
          Listed directory <Text bold>{dir}</Text>
        </AttachmentLine>
      )
    }

    case 'file':
    case 'already_read_file': {
      if (attachment.content.type === 'notebook') {
        const count = attachment.content.file.cells.length
        return (
          <AttachmentLine>
            Read <Text bold>{attachment.displayPath}</Text> ({count}{' '}
            {plural(count, 'cell')})
          </AttachmentLine>
        )
      }
      if (attachment.type === 'already_read_file') {
        return (
          <AttachmentLine>
            Re-read <Text bold>{attachment.displayPath}</Text> (unchanged)
          </AttachmentLine>
        )
      }
      if (attachment.content.type === 'text') {
        const count = attachment.content.file.numLines
        return (
          <AttachmentLine>
            Read <Text bold>{attachment.displayPath}</Text> ({count}
            {attachment.truncated ? '+' : ''} {plural(count, 'line')})
          </AttachmentLine>
        )
      }
      const pdfSize =
        attachment.content.type === 'pdf' && attachment.content.file.originalSize
          ? ` (${formatFileSize(attachment.content.file.originalSize)})`
          : ''
      return (
        <AttachmentLine>
          Read <Text bold>{attachment.displayPath}</Text>
          {pdfSize}
        </AttachmentLine>
      )
    }

    case 'compact_file_reference':
      return (
        <AttachmentLine>
          Referenced <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'pdf_reference':
      return (
        <AttachmentLine>
          Referenced PDF <Text bold>{attachment.displayPath}</Text> (
          {attachment.pageCount} {plural(attachment.pageCount, 'page')})
        </AttachmentLine>
      )

    case 'dropped_image_file':
      return (
        <MessageResponse>
          <Text dimColor wrap="wrap">
            Dropped <Text bold>{attachment.displayPath}</Text> — {attachment.reason}
          </Text>
        </MessageResponse>
      )

    case 'nested_memory':
      return (
        <AttachmentLine>
          Loaded instruction file <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'dynamic_skill': {
      const count = attachment.skillNames.length
      return (
        <AttachmentLine>
          Loaded {count} {plural(count, 'skill')} from{' '}
          <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )
    }

    case 'skill_listing':
      if (attachment.isInitial) return null
      return (
        <AttachmentLine>
          {attachment.skillCount} {plural(attachment.skillCount, 'skill')} available
        </AttachmentLine>
      )

    case 'invoked_skills': {
      if (attachment.skills.length === 0) return null
      const names = attachment.skills.map(skill => skill.name).join(', ')
      return (
        <AttachmentLine>
          Restored {plural(attachment.skills.length, 'skill')} {names}
        </AttachmentLine>
      )
    }

    case 'diagnostics':
      return <DiagnosticsDisplay attachment={attachment} verbose={verbose} />

    case 'mcp_resource':
      return (
        <AttachmentLine>
          Read MCP resource <Text bold>{attachment.name}</Text> from{' '}
          {attachment.server}
        </AttachmentLine>
      )

    case 'queued_command': {
      if (
        !isTranscriptMode &&
        (attachment.boardEventIds !== undefined || attachment.isMeta === true)
      ) {
        return null
      }
      let promptText = ''
      if (typeof attachment.prompt === 'string') {
        promptText = attachment.prompt
      } else {
        const parts: string[] = []
        for (const block of attachment.prompt) {
          if (block.type === 'text') parts.push(block.text)
        }
        promptText = parts.join('\n')
      }
      const isTaskNotification = attachment.commandMode === 'task-notification'
      return (
        <Box
          flexDirection="column"
          marginTop={addMargin ? 1 : 0}
          backgroundColor={selectedBg}
        >
          <UserTextMessage
            addMargin={false}
            param={{ type: 'text', text: promptText }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
            origin={attachment.origin}
            notice={isTaskNotification ? true : undefined}
            noticeSentAt={isTaskNotification ? attachment.sentAt : undefined}
            noticeDeliveredAt={
              isTaskNotification ? attachment.deliveredAt : undefined
            }
          />
          {attachment.imagePasteIds?.map((id, index) => (
            <UserImageMessage key={`${id}-${index}`} imageId={id} />
          ))}
        </Box>
      )
    }

    case 'hook': {
      switch (attachment.outcome) {
        case 'block': {
          const newlineAt = attachment.words.indexOf('\n')
          const head =
            newlineAt === -1
              ? attachment.words
              : attachment.words.slice(0, newlineAt)
          const rest =
            newlineAt === -1 ? null : attachment.words.slice(newlineAt + 1)
          return (
            <Box flexDirection="column">
              <MessageResponse height={1}>
                <Text color="error" wrap="wrap">
                  hook {attachment.name} blocked {attachment.event}: {head}
                </Text>
              </MessageResponse>
              {rest !== null ? (
                <HookOutputBlock
                  output={rest}
                  hookName={attachment.name}
                  hookEvent={attachment.event}
                  verbose={verbose}
                />
              ) : null}
            </Box>
          )
        }
        case 'stop':
          return (
            <MessageResponse height={1}>
              <Text color="warning" wrap="wrap">
                hook {attachment.name} stopped the turn: {attachment.words}
              </Text>
            </MessageResponse>
          )
        case 'failed':
          return (
            <MessageResponse height={1}>
              <Text color="error" wrap="wrap">
                {attachment.words}
              </Text>
            </MessageResponse>
          )
        case 'notice':
          return (
            <AttachmentLine>
              {attachment.words} · hook {attachment.name}
            </AttachmentLine>
          )
        case 'context':
        case 'text':
          if (!verbose && !isTranscriptMode) return null
          return (
            <HookOutputBlock
              output={attachment.words}
              hookName={attachment.name}
              hookEvent={attachment.event}
              verbose={verbose}
            />
          )
        default:
          return null
      }
    }

    case 'bypassed_ask':
      return (
        <MessageResponse>
          <Text dimColor wrap="wrap">
            allowed by {permissionModeTitle(attachment.mode).toLowerCase()}
          </Text>
        </MessageResponse>
      )

    case 'skill_discovery':
    case 'command_permissions':
      return null

    default: {
      const _exhaustive: NullRenderingAttachmentType = attachment.type
      void _exhaustive
      return null
    }
  }
}

export default AttachmentMessage
