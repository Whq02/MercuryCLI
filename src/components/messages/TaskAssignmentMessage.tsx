// Task-assignment card + summary. Mercury renders this as a STRUCTURAL
// information card — the subtle border with an info-toned header — because
// an assignment notice reports a fact about work; the per-agent identity
// colour role is deliberately not used here. Tokens are subscribed so an
// appearance change repaints mounted cards.

import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  isTaskAssignment,
  type TaskAssignmentMessage as TaskAssignmentPayload,
} from '../../utils/teammateMailbox.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

export function TaskAssignmentDisplay({
  assignment,
  senderName,
}: {
  assignment: TaskAssignmentPayload
  senderName?: string
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.textMuted}
      paddingX={1}
    >
      <Text color={tokens.info}>
        Task #{assignment.taskId} assigned by{' '}
        {assignment.assignedBy || senderName || 'the lead'}
      </Text>
      <Text bold>{assignment.subject}</Text>
      {assignment.description ? (
        <Text dimColor>{assignment.description}</Text>
      ) : null}
    </Box>
  )
}

/** A task-assignment card for a raw payload, or null. */
export function tryRenderTaskAssignmentMessage(
  content: string,
  senderName?: string,
): React.ReactNode | null {
  const assignment = isTaskAssignment(content)
  if (!assignment) return null
  return (
    <TaskAssignmentDisplay assignment={assignment} senderName={senderName} />
  )
}

/** Bracketed-label summary for queue/inbox surfaces. */
export function getTaskAssignmentSummary(content: string): string | null {
  const assignment = isTaskAssignment(content)
  if (!assignment) return null
  return `[task] #${assignment.taskId} ${assignment.subject} — assigned by ${assignment.assignedBy}`
}
