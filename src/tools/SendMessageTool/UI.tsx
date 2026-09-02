import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Input, SendMessageToolOutput } from './SendMessageTool.js'


export function renderToolUseMessage(input?: Partial<Input>): React.ReactNode {
  const message = input?.message
  if (message && typeof message === 'object' && message.type === 'plan_approval_response') {
    return `${message.approve ? 'Approved' : 'Rejected'} plan from ${input?.to ?? ''}`
  }
  return null
}

export function renderToolResultMessage(
  content: SendMessageToolOutput | string,
  _progressMessages: unknown,
  _options: { verbose: boolean },
): React.ReactNode {
  let output: SendMessageToolOutput | undefined
  if (typeof content === 'string') {
    try {
      output = JSON.parse(content) as SendMessageToolOutput
    } catch {
      return (
        <MessageResponse>
          <Text dimColor>{content}</Text>
        </MessageResponse>
      )
    }
  } else {
    output = content
  }
  if (!output) return null
  const record = output as unknown as Record<string, unknown>
  if (record.routing) return null
  if ('request_id' in record && 'target' in record) return null
  return (
    <MessageResponse>
      <Text dimColor>{output.message}</Text>
    </MessageResponse>
  )
}
