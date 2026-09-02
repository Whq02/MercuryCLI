import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import type { RememberLessonOutput } from './RememberLessonTool.js'

export function renderRememberToolUseMessage(
  input: Partial<{ title: string; problemClass: string }>,
): React.ReactNode {
  return input.title ? truncate(input.title, 60, true) : (input.problemClass ?? '')
}

export function renderRememberResultMessage(output: RememberLessonOutput): React.ReactNode {
  return (
    <MessageResponse>
      {output.banked ? (
        <Text>
          Banked a <Text bold>candidate</Text> lesson <Text dimColor>(promote to fully trust)</Text>
        </Text>
      ) : (
        <Text dimColor>Not banked: {output.reason}</Text>
      )}
    </MessageResponse>
  )
}
