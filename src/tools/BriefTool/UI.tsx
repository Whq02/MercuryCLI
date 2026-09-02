// Rendering of a delivered user message: transcript /
// brief-only / chatroom / default views. The nameplate and chatroom paths
// are Mercury-original.
//
// The default view's inline nameplate is built from the tool's OWN
// timestamp — no honest timestamp ⇒ NO plate, never a guessed one
// (prover-pinned). The plate rides Markdown's leadingInline prop.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../../components/Markdown.js'
import { formatClock } from '../../components/messages/TranscriptNameplate.js'
import { FAINT, TERRA } from '../../components/mercuryPalette.js'
import type { ProgressMessage } from '../../types/message.js'
import { getDisplayPath } from '../../utils/file.js'
import type { Output } from './BriefTool.js'
import type { ResolvedAttachment } from './attachments.js'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

/** One dim pointer row per attachment: marker, display path, size. */
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

/** The tool-use row is empty. */
export function renderToolUseMessage(): React.ReactNode {
  return null
}

/** The inline nameplate: dim clock, dim bracket, accent product name, dim
 *  bracket. Only from an honest timestamp. */
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

  // Transcript mode: model text is not filtered there, so the bullet keeps
  // this visually distinct.
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

  // Brief-only (chat) view: assistant label with the formatted timestamp,
  // message + attachments indented two columns.
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

  // Default: the message with a leading inline nameplate from the tool's
  // own timestamp — the surrounding assistant text is filtered away, and a
  // context-driven plate would misattribute the row. No timestamp, no
  // plate.
  const plate = output.sentAt ? inlinePlate(output.sentAt) : null
  return (
    <Box flexDirection="column">
      <Markdown leadingInline={plate ?? undefined}>{message ?? ''}</Markdown>
      <AttachmentList attachments={attachments} />
    </Box>
  )
}
