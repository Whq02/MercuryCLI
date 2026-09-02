import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { CreateOutput } from './CronCreateTool.js'
import type { DeleteOutput } from './CronDeleteTool.js'
import type { ListOutput } from './CronListTool.js'

/** Header/result renderers for the three scheduling tools. */

/** Prompts are truncated to this many characters in the create header. */
const HEADER_PROMPT_CHARS = 60

export function renderCreateToolUseMessage(input?: { cron?: string; prompt?: string }): React.ReactNode {
  const cron = input?.cron ?? ''
  if (!input?.prompt) return cron
  const prompt =
    input.prompt.length > HEADER_PROMPT_CHARS ? `${input.prompt.slice(0, HEADER_PROMPT_CHARS)}…` : input.prompt
  return `${cron}: ${prompt}`
}

export function renderCreateResultMessage(output: CreateOutput): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text>
        Schedule submitted <Text dimColor>({output.humanSchedule})</Text>
      </Text>
    </MessageResponse>
  )
}

export function renderDeleteToolUseMessage(input?: { id?: string }): React.ReactNode {
  return input?.id ?? ''
}

export function renderDeleteResultMessage(output: DeleteOutput): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text>
        Cancel submitted for <Text bold>{output.id}</Text>
      </Text>
    </MessageResponse>
  )
}

export function renderListToolUseMessage(): React.ReactNode {
  return ''
}

export function renderListResultMessage(output: ListOutput): React.ReactNode {
  if (!output.rosterKnown || !output.schedules || output.schedules.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{output.rosterKnown ? 'No schedules' : 'No roster yet'}</Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {output.schedules.map(row => (
          <Text key={row.id}>
            <Text bold>{row.id}</Text> <Text dimColor>{row.when}</Text>
          </Text>
        ))}
      </Box>
    </MessageResponse>
  )
}
