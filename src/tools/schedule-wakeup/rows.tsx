import React from 'react'
import { MessageResponse } from '../kit/MessageResponse.js'
import { Text } from '../../screen/themedRenderer.js'
import { truncate } from '../../platform/text/format.js'
import type { WakeupOutput } from './ScheduleWakeupTool.js'

export function renderWakeupToolUseMessage(
  input: Partial<{ delaySeconds: number; prompt: string }>,
): React.ReactNode {
  const delay = input.delaySeconds != null ? `${input.delaySeconds}s` : ''
  const prompt = input.prompt ? `: ${truncate(input.prompt, 60, true)}` : ''
  return `${delay}${prompt}`
}

export function renderWakeupResultMessage(
  output: WakeupOutput,
): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        Waking in <Text bold>{output.delaySeconds}s</Text>{' '}
        <Text dimColor>({output.humanSchedule})</Text>
      </Text>
    </MessageResponse>
  )
}
