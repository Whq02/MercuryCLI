
import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  isIdleNotification,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  type PlanApprovalRequestMessage,
  type PlanApprovalResponseMessage,
} from '../../utils/teammateMailbox.js'
import { Markdown } from '../Markdown.js'
import { getShutdownMessageSummary } from './ShutdownMessage.js'
import { getTaskAssignmentSummary } from './TaskAssignmentMessage.js'

const DASHED_RULE = '┄'.repeat(40)

export function PlanApprovalRequestDisplay({
  request,
  senderName,
}: {
  request: PlanApprovalRequestMessage
  senderName?: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="strategyMode" paddingX={1}>
      <Text bold color="strategyMode">
        Plan approval requested by {senderName ?? request.from}
      </Text>
      <Text dimColor>{DASHED_RULE}</Text>
      <Markdown>{request.planContent}</Markdown>
      <Text dimColor>{DASHED_RULE}</Text>
      <Text dimColor>Plan file: {request.planFilePath}</Text>
    </Box>
  )
}

export function PlanApprovalResponseDisplay({
  response,
  senderName,
}: {
  response: PlanApprovalResponseMessage
  senderName?: string
}): React.ReactNode {
  if (response.approved) {
    return (
      <Box flexDirection="column">
        <Text color="success">
          Plan approved{senderName ? ` by ${senderName}` : ''} — plan-mode
          restrictions are lifted.
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text color="error">
        Plan rejected{senderName ? ` by ${senderName}` : ''}.
      </Text>
      {response.feedback ? (
        <Box flexDirection="column">
          <Text dimColor>{DASHED_RULE}</Text>
          <Text>{response.feedback}</Text>
          <Text dimColor>{DASHED_RULE}</Text>
        </Box>
      ) : null}
      <Text dimColor>
        Revise the plan and call ExitStrategyMode again when it is ready.
      </Text>
    </Box>
  )
}

export function tryRenderPlanApprovalMessage(
  content: string,
  senderName?: string,
): React.ReactNode | null {
  const request = isPlanApprovalRequest(content)
  if (request) {
    return (
      <PlanApprovalRequestDisplay request={request} senderName={senderName} />
    )
  }
  const response = isPlanApprovalResponse(content)
  if (response) {
    return (
      <PlanApprovalResponseDisplay response={response} senderName={senderName} />
    )
  }
  return null
}

function planApprovalSummary(content: string): string | null {
  const request = isPlanApprovalRequest(content)
  if (request) return `[plan approval] requested by ${request.from}`
  const response = isPlanApprovalResponse(content)
  if (response) {
    if (response.approved) return '[plan approval] approved'
    return response.feedback
      ? `[plan approval] rejected — ${response.feedback}`
      : '[plan approval] rejected — revise and resubmit'
  }
  return null
}

function idleNotificationSummary(content: string): string | null {
  const idle = isIdleNotification(content)
  if (!idle) return null
  const parts = [`@${idle.from} is idle`]
  if (idle.completedTaskId) {
    parts.push(
      `completed #${idle.completedTaskId}${idle.completedStatus ? ` (${idle.completedStatus})` : ''}`,
    )
  }
  if (idle.summary) parts.push(idle.summary)
  return parts.join(' · ')
}

export function formatTeammateMessageContent(content: string): string {
  const plan = planApprovalSummary(content)
  if (plan !== null) return plan
  const shutdown = getShutdownMessageSummary(content)
  if (shutdown !== null) return shutdown
  const idle = idleNotificationSummary(content)
  if (idle !== null) return idle
  const assignment = getTaskAssignmentSummary(content)
  if (assignment !== null) return assignment
  try {
    const parsed = JSON.parse(content) as {
      type?: string
      message?: string
    }
    if (parsed?.type === 'teammate_terminated' && parsed.message) {
      return parsed.message
    }
  } catch {
  }
  return content
}
