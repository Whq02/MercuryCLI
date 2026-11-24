import * as React from 'react'

import { MessageResponse } from '../kit/MessageResponse.js'
import { Text } from '../../screen/themedRenderer.js'
import type { Input, SendMessageToolOutput } from './SendMessageTool.js'

export const DELIVERED_MODEL_TAIL = '; it reads it at its next tool boundary.'
export function renderToolUseMessage(_input?: Partial<Input>): React.ReactNode {
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
  const shown = output.message.endsWith(DELIVERED_MODEL_TAIL)
    ? output.message.slice(0, -DELIVERED_MODEL_TAIL.length)
    : output.message
  return (
    <MessageResponse>
      <Text dimColor>{shown}</Text>
    </MessageResponse>
  )
}
