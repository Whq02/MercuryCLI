import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { CreateOutput } from './CronCreateTool.js'
import type { DeleteOutput } from './CronDeleteTool.js'
import type { ListOutput } from './CronListTool.js'

const HEADER_PROMPT_CHARS = 60

type CreateHeaderInput = { cron?: string; at?: string; delayMinutes?: number; prompt?: string }

function Row({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text>{children}</Text>
    </MessageResponse>
  )
}

const Dim = ({ children }: { children: React.ReactNode }): React.ReactNode => <Text dimColor>{children}</Text>

const quoted = (title: string | undefined): string => (title === undefined ? '' : ` "${title}"`)

const scheduleSpelling = (input: CreateHeaderInput): string => {
  if (input.cron !== undefined) return input.cron
  if (input.at !== undefined) return `at ${input.at}`
  if (input.delayMinutes !== undefined) return `in ${input.delayMinutes} min`
  return ''
}

const cutPrompt = (prompt: string): string =>
  prompt.length > HEADER_PROMPT_CHARS ? `${prompt.slice(0, HEADER_PROMPT_CHARS)}…` : prompt

export function renderCreateToolUseMessage(input?: CreateHeaderInput): React.ReactNode {
  const spelling = scheduleSpelling(input ?? {})
  return input?.prompt ? `${spelling}: ${cutPrompt(input.prompt)}` : spelling
}

export function renderCreateResultMessage(output: CreateOutput): React.ReactNode {
  if (output.state === 'scheduled') {
    return (
      <Row>
        Scheduled <Text bold>{output.id}</Text>{quoted(output.title)} <Dim>({output.nextFireLocal})</Dim>
      </Row>
    )
  }
  if (output.state === 'queued') {
    return (
      <Row>
        Queued, not confirmed <Dim>({output.humanSchedule})</Dim>
      </Row>
    )
  }
  return (
    <Row>
      Schedule{quoted(output.title)} submitted <Dim>({output.humanSchedule})</Dim>
    </Row>
  )
}

export function renderDeleteToolUseMessage(input?: { id?: string }): React.ReactNode {
  return input?.id ?? ''
}

export function renderDeleteResultMessage(output: DeleteOutput): React.ReactNode {
  return (
    <Row>
      Cancel submitted for <Text bold>{output.id}</Text>
    </Row>
  )
}

export function renderListToolUseMessage(): React.ReactNode {
  return ''
}

function ScheduleLine({ row }: { row: NonNullable<ListOutput['schedules']>[number] }): React.ReactNode {
  return (
    <Text>
      <Text bold>{row.id}</Text>{row.title !== undefined ? ` · ${row.title}` : ''} <Dim>{row.when}</Dim>
    </Text>
  )
}

export function renderListResultMessage(output: ListOutput): React.ReactNode {
  const schedules = output.rosterKnown ? output.schedules ?? [] : null
  if (schedules === null || schedules.length === 0) {
    return (
      <MessageResponse height={1}>
        <Dim>{schedules === null ? 'No roster yet' : 'No schedules'}</Dim>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {schedules.map(row => (
          <ScheduleLine key={row.id} row={row} />
        ))}
      </Box>
    </MessageResponse>
  )
}
