
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../../components/Markdown.js'
import { ChatLine } from '../../components/messages/ChatLine.js'
import { formatClock } from '../../components/messages/TranscriptNameplate.js'
import { FAINT, TERRA } from '../../components/mercuryPalette.js'
import type { ProgressMessage } from '../../types/message.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  isImplementerRole,
  scribeChatroomEnabled,
} from '../../utils/scribe/scribeGates.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import type { Output } from './BriefTool.js'
import type { ResolvedAttachment } from './attachments.js'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

export function AttachmentList({
  attachments,
}: {
  attachments: readonly ResolvedAttachment[]
}): React.ReactNode {
  if (attachments.length === 0) return null
  return (
    <Box flexDirection="column">
      {attachments.map((attachment, index) => (
        <Text key={index} dimColor>
          {'  └ '}
          {attachment.isImage ? '[image] ' : '[file] '}
          {getDisplayPath(attachment.path)} ({formatSize(attachment.size)})
        </Text>
      ))}
    </Box>
  )
}

export function renderToolUseMessage(): React.ReactNode {
  return null
}

function inlinePlate(sentAt: string): React.ReactNode | null {
  const clock = formatClock(sentAt)
  if (!clock) return null
  return (
    <Text>
      <Text color={FAINT}>{clock} </Text>
      <Text color={FAINT}>[</Text>
      <Text color={TERRA}>Mercury</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}

export function renderToolResultMessage(
  output: Output,
  progressMessages?: readonly ProgressMessage[],
  options?: { isTranscriptMode?: boolean; isBriefOnly?: boolean },
): React.ReactNode {
  void progressMessages
  const message = output?.message
  const attachments = output?.attachments ?? []
  if (!message && attachments.length === 0) return null

  if (options?.isTranscriptMode) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>• </Text>
          <Box flexDirection="column">
            <Markdown>{message ?? ''}</Markdown>
          </Box>
        </Box>
        <AttachmentList attachments={attachments} />
      </Box>
    )
  }

  if (options?.isBriefOnly) {
    const clock = output.sentAt ? formatClock(output.sentAt) : null
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={TERRA}>Mercury</Text>
          {clock ? <Text color={FAINT}> {clock}</Text> : null}
        </Text>
        <Box marginLeft={2} flexDirection="column">
          <Markdown>{message ?? ''}</Markdown>
          <AttachmentList attachments={attachments} />
        </Box>
      </Box>
    )
  }

  if (message && isScribeModeOn() && scribeChatroomEnabled() && !isImplementerRole()) {
    return (
      <Box flexDirection="column">
        <ChatLine author="scribe" body={message} />
        <AttachmentList attachments={attachments} />
      </Box>
    )
  }

  const plate = output.sentAt ? inlinePlate(output.sentAt) : null
  return (
    <Box flexDirection="column">
      <Markdown leadingInline={plate ?? undefined}>{message ?? ''}</Markdown>
      <AttachmentList attachments={attachments} />
    </Box>
  )
}
