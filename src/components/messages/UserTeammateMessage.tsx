// Teammate relay rows. Shutdown-approved and teammate-terminated payloads
// are pre-filtered so they cannot leave an empty wrapper producing a blank
// line between turns. A coordination envelope (the bus protocol) is
// machine-to-machine: the model still receives it, the human transcript
// never shows the raw JSON.

import figures from 'figures'
import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { toInkColor } from '../../utils/ink.js'
import {
  isIdleNotification,
  isShutdownApproved,
} from '../../utils/teammateMailbox.js'
import { parseBusEnvelope } from '../../utils/swarm/busEnvelopes.js'
import { tryRenderPlanApprovalMessage } from './PlanApprovalMessage.js'
import { tryRenderShutdownMessage } from './ShutdownMessage.js'
import { tryRenderTaskAssignmentMessage } from './TaskAssignmentMessage.js'

type RelayedMessage = {
  teammateId: string
  color: string | undefined
  summary: string | undefined
  content: string
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`))
  return match?.[1]
}

function parseTeammateMessages(text: string): RelayedMessage[] {
  const out: RelayedMessage[] = []
  const re = /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const attrs = match[1] ?? ''
    out.push({
      teammateId: attribute(attrs, 'teammate_id') ?? 'teammate',
      color: attribute(attrs, 'color'),
      summary: attribute(attrs, 'summary'),
      content: (match[2] ?? '').trim(),
    })
  }
  return out
}

function isTerminated(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { type?: string }
    return parsed?.type === 'teammate_terminated'
  } catch {
    return false
  }
}

function taskCompletedOf(
  content: string,
): { taskId: string; subject?: string } | null {
  try {
    const parsed = JSON.parse(content) as {
      type?: string
      taskId?: string
      subject?: string
    }
    if (parsed?.type === 'task_completed' && parsed.taskId) {
      return { taskId: parsed.taskId, subject: parsed.subject }
    }
    return null
  } catch {
    return null
  }
}

export function TeammateMessageContent({
  message,
  isTranscriptMode,
}: {
  message: RelayedMessage
  isTranscriptMode?: boolean
}): React.ReactNode {
  // The sender is the VERIFIED teammate id, never prose inside the payload.
  const senderName = message.teammateId

  const planCard = tryRenderPlanApprovalMessage(message.content, senderName)
  if (planCard) return planCard
  const shutdownCard = tryRenderShutdownMessage(message.content)
  if (shutdownCard) return shutdownCard
  const assignmentCard = tryRenderTaskAssignmentMessage(
    message.content,
    senderName,
  )
  if (assignmentCard) return assignmentCard

  // Processed silently.
  if (isIdleNotification(message.content)) return null

  // Machine-to-machine coordination: the model still receives it, but the
  // human transcript never shows the raw JSON.
  if (parseBusEnvelope(message.content) !== null) return null

  const completed = taskCompletedOf(message.content)
  if (completed) {
    return (
      <Text>
        <Text color={toInkColor(message.color)}>
          {figures.pointer} @{senderName}
        </Text>{' '}
        <Text color="success">{figures.tick}</Text> completed #
        {completed.taskId}
        {completed.subject ? <Text dimColor> {completed.subject}</Text> : null}
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={toInkColor(message.color)}>
          {figures.pointer} @{senderName}
        </Text>
        {message.summary ? <Text> {message.summary}</Text> : null}
      </Text>
      {isTranscriptMode && message.content ? (
        <Box paddingLeft={2}>
          <Ansi>{message.content}</Ansi>
        </Box>
      ) : null}
    </Box>
  )
}

export function UserTeammateMessage({
  addMargin,
  param,
  isTranscriptMode,
}: {
  addMargin: boolean
  param: TextBlockParam
  isTranscriptMode?: boolean
}): React.ReactNode {
  const relayed = parseTeammateMessages(param.text).filter(
    message =>
      !isShutdownApproved(message.content) && !isTerminated(message.content),
  )
  if (relayed.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      {relayed.map((message, index) => (
        <TeammateMessageContent
          key={index}
          message={message}
          isTranscriptMode={isTranscriptMode}
        />
      ))}
    </Box>
  )
}

export default UserTeammateMessage
