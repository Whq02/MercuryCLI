// Teammate relay rows, including the scribe-bus envelope rendering.
// Shutdown-approved and teammate-terminated payloads are pre-filtered so
// they cannot leave an empty wrapper producing a blank line between turns.
// The scribe-protocol projection is attributed from the VERIFIED sender id,
// never from prose inside the payload — the anti-impersonation anchor.

import figures from 'figures'
import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { toInkColor } from '../../utils/ink.js'
import {
  isIdleNotification,
  isShutdownApproved,
} from '../../utils/teammateMailbox.js'
import {
  BUS_TEAM_LEAD_NAME,
  IMPLEMENTER_AGENT_NAME,
  IMPLEMENTER_DISPLAY_NAME,
  SCRIBE_DISPLAY_NAME,
} from '../../utils/scribe/busIdentity.js'
import { scribeChatroomEnabled } from '../../utils/scribe/scribeGates.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import {
  classifyAuthor,
  scribeEnvelopeOf,
} from '../mercury-ui/scribeChatTabs.js'
import { ChatLine } from './ChatLine.js'
import { formatClock, useMessageMeta } from './TranscriptNameplate.js'
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

/** Display name for a relay sender (contract data: the addressing table's
 *  own ids — both `scribe` and `team-lead` map to the scribe display name,
 *  the implementer agent id to the implementer display name). */
export function scribeRelayName(teammateId: string): string {
  if (teammateId === 'scribe' || teammateId === BUS_TEAM_LEAD_NAME) {
    return SCRIBE_DISPLAY_NAME
  }
  if (teammateId === IMPLEMENTER_AGENT_NAME) return IMPLEMENTER_DISPLAY_NAME
  return teammateId
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
  // The message-metadata hook runs unconditionally, above any chatroom
  // branch (hook-order rule).
  const meta = useMessageMeta()
  const senderName = scribeRelayName(message.teammateId)

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

  const envelope = scribeEnvelopeOf({ content: message.content })
  if (envelope) {
    // Machine-to-machine coordination: the model still receives it, but the
    // human transcript never shows the raw JSON. With the chatroom on, a
    // human-readable projection renders attributed from the VERIFIED sender.
    if (scribeChatroomEnabled()) {
      const author = classifyAuthor({ content: message.content })
      const body =
        (envelope as { body?: string; summary?: string }).body ??
        (envelope as { summary?: string }).summary ??
        message.summary ??
        ''
      if (body === '') return null
      return <ChatLine author={author} body={body} />
    }
    return null
  }

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

  if (isScribeModeOn()) {
    if (scribeChatroomEnabled()) {
      return (
        <ChatLine
          author={classifyAuthor({ content: message.content })}
          body={message.content || message.summary || ''}
        />
      )
    }
    // The nameplate's clock reads the timestamp PERSISTED on the message —
    // never the wall clock at render time.
    const clock = formatClock(meta?.timestamp)
    return (
      <Box flexDirection="column">
        <Text>
          {clock ? <Text dimColor>{clock} </Text> : null}
          <Text dimColor>[</Text>
          <Text color={toInkColor(message.color)}>{senderName}</Text>
          <Text dimColor>] </Text>
          {message.summary ?? ''}
        </Text>
        {isTranscriptMode && message.content ? (
          <Box paddingLeft={2}>
            <Ansi>{message.content}</Ansi>
          </Box>
        ) : null}
      </Box>
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
