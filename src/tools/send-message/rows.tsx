import * as React from 'react'

import { MessageResponse } from '../kit/MessageResponse.js'
import { Text } from '../../screen/themedRenderer.js'
import type { Input, SendMessageToolOutput } from './SendMessageTool.js'

export const DELIVERED_MODEL_TAIL = '; it reads it at its next tool boundary.'
export const NOT_DELIVERED_MODEL_TAIL =
  ', so no turn of it is running to read a message. To give it this message as a new turn, call ResumeCrewmate with the same to and message.'
const MODEL_ONLY_TAILS: readonly string[] = [DELIVERED_MODEL_TAIL, NOT_DELIVERED_MODEL_TAIL]
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
  const tail = MODEL_ONLY_TAILS.find(suffix => output.message.endsWith(suffix))
  const shown = tail === undefined ? output.message : output.message.slice(0, -tail.length)
  return (
    <MessageResponse>
      <Text dimColor>{shown}</Text>
    </MessageResponse>
  )
}
