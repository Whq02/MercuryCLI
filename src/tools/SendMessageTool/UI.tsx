import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Input, SendMessageToolOutput } from './SendMessageTool.js'

/** Minimal header/result renderers for SendMessage. */

/** Only a plan approval response renders a header line. */
export function renderToolUseMessage(input?: Partial<Input>): React.ReactNode {
  const message = input?.message
  if (message && typeof message === 'object' && message.type === 'plan_approval_response') {
    return `${message.approve ? 'Approved' : 'Rejected'} plan from ${input?.to ?? ''}`
  }
  return null
}

/**
 * Results carrying a truthy `routing`, and results carrying both
 * `request_id` and `target`, are painted by dedicated transcript surfaces
 * and render nothing here. Everything else renders its message dimmed. The
 * content may arrive as the object or its persisted JSON string.
 */
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
