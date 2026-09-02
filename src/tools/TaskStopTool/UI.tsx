import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { truncateToWidthNoEllipsis } from '../../utils/format.js'
import type { Output } from './TaskStopTool.js'


const MAX_COMMAND_LINES = 2
const MAX_COMMAND_COLUMNS = 160

export function renderToolUseMessage(): React.ReactNode {
  return ''
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const command = output.command ?? ''
  let shown = command
  if (!verbose) {
    shown = truncateToWidthNoEllipsis(command.split('\n').slice(0, MAX_COMMAND_LINES).join('\n'), MAX_COMMAND_COLUMNS).trim()
  }
  const suffix = shown !== command ? '… stopped' : ' stopped'
  const ended = output.processes_ended
  const survivors = output.process_survivors
  const countClause =
    ended !== undefined
      ? ` · ended ${ended} process${ended === 1 ? '' : 'es'}${survivors ? ` (${survivors} unconfirmed)` : ''}`
      : ''
  return (
    <MessageResponse>
      <Text>
        {shown}
        {suffix}
        {countClause}
      </Text>
    </MessageResponse>
  )
}
