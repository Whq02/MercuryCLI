
import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { formatFileSize } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js'
import { MessageResponse } from '../MessageResponse.js'
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js'
import { UserImageMessage } from './UserImageMessage.js'
import { UserTextMessage } from './UserTextMessage.js'
import { useSelectedMessageBg } from '../messageActions.js'

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
  if (attachment.type === 'skill_discovery') return null

  switch (attachment.type) {
    case 'directory':
      return (
        <AttachmentLine>
          Listed directory{' '}
          <Text bold>
            {attachment.displayPath.endsWith('/')
              ? attachment.displayPath
              : `${attachment.displayPath}/`}
          </Text>
        </AttachmentLine>
      )

    case 'file':
    case 'already_read_file': {
      const content = attachment.content
      if (content.type === 'notebook') {
        return (
          <AttachmentLine>
            Read <Text bold>{attachment.displayPath}</Text> (
            {content.file.cells.length} {plural(content.file.cells.length, 'cell')})
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
      if (content.type === 'text') {
        return (
          <AttachmentLine>
            Read <Text bold>{attachment.displayPath}</Text> (
            {content.file.numLines}
            {attachment.truncated ? '+' : ''} {plural(content.file.numLines, 'line')})
          </AttachmentLine>
        )
      }
      const size =
        content.type === 'pdf' ? content.file.originalSize : undefined
      return (
        <AttachmentLine>
          Read <Text bold>{attachment.displayPath}</Text>
          {size !== undefined ? ` (${formatFileSize(size)})` : ''}
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

    case 'nested_memory':
      return (
        <AttachmentLine>
          Loaded instruction file <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'relevant_memories': {
      const count = attachment.memories.length
      if (count === 0) return null
      if (!verbose && !isTranscriptMode) {
        return (
          <AttachmentLine>
            Recalled {count} {plural(count, 'memory')} <CtrlOToExpand />
          </AttachmentLine>
        )
      }
      return (
        <Box flexDirection="column">
          <AttachmentLine>
            Recalled {count} {plural(count, 'memory')}
          </AttachmentLine>
          {attachment.memories.map(memory => {
            const basename = memory.path.split(/[\\/]/).pop() ?? memory.path
            return (
              <Box key={memory.path} flexDirection="column" paddingLeft={2}>
                <Text dimColor>
                  <Link url={`file://${memory.path}`} fallback={basename}>
                    {basename}
                  </Link>
                </Text>
                {isTranscriptMode ? <Ansi dimColor>{memory.content}</Ansi> : null}
              </Box>
            )
          })}
        </Box>
      )
    }

    case 'dynamic_skill':
      return (
        <AttachmentLine>
          Loaded {attachment.skillNames.length}{' '}
          {plural(attachment.skillNames.length, 'skill')} from{' '}
          <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'skill_listing':
      if (attachment.isInitial) return null
      return (
        <AttachmentLine>
          {attachment.skillCount} {plural(attachment.skillCount, 'skill')}{' '}
          available
        </AttachmentLine>
      )

    case 'queued_command': {
      const prompt = attachment.prompt
      const text =
        typeof prompt === 'string'
          ? prompt
          : prompt
              .filter(block => block.type === 'text')
              .map(block => (block as { text: string }).text)
              .join('\n')
      return (
        <Box
          flexDirection="column"
          marginTop={addMargin ? 1 : 0}
          backgroundColor={selectedBg}
        >
          <UserTextMessage
            addMargin={false}
            param={{ type: 'text', text }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
            notice={attachment.commandMode === 'task-notification'}
            noticeSentAt={attachment.commandMode === 'task-notification' ? attachment.sentAt : undefined}
            noticeDeliveredAt={attachment.commandMode === 'task-notification' ? attachment.deliveredAt : undefined}
            origin={attachment.origin}
          />
          {(attachment.imagePasteIds ?? []).map(id => (
            <UserImageMessage key={id} imageId={id} />
          ))}
        </Box>
      )
    }

    case 'invoked_skills': {
      if (attachment.skills.length === 0) return null
      return (
        <AttachmentLine>
          Restored {plural(attachment.skills.length, 'skill')}{' '}
          {attachment.skills.map(skill => skill.name).join(', ')}
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

    case 'command_permissions':
      return null

    case 'hook': {
      const lead = `hook ${attachment.name}`
      switch (attachment.outcome) {
        case 'block':
          return (
            <Box flexDirection="column">
              <Text color="error">
                {lead} blocked {attachment.event}: {attachment.words.split('\n')[0]}
              </Text>
              {attachment.words.includes('\n') ? <HookOutputBlock output={attachment.words.split('\n').slice(1).join('\n')} hookName={attachment.name} hookEvent={attachment.event} verbose={verbose} /> : null}
            </Box>
          )
        case 'stop':
          return (
            <Text color="warning">
              {lead} stopped the turn: {attachment.words}
            </Text>
          )
        case 'failed':
          return <Text color="error">{attachment.words}</Text>
        case 'notice':
          return (
            <AttachmentLine>
              {attachment.words} · {lead}
            </AttachmentLine>
          )
        case 'context':
        case 'text': {
          if (!isTranscriptMode && !verbose) return null
          return <HookOutputBlock output={attachment.words} hookName={attachment.name} hookEvent={attachment.event} verbose={verbose} />
        }
      }
      return null
    }

    case 'bypassed_ask':
      return (
        <MessageResponse>
          <Text dimColor wrap="wrap">
            Allowed by {permissionModeTitle(attachment.mode).toLowerCase()} · {attachment.reason}
          </Text>
        </MessageResponse>
      )

    default: {
      const nullRendering: NullRenderingAttachmentType = attachment.type
      void nullRendering
      return null
    }
  }
}

export default AttachmentMessage
