import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { truncateToWidthNoEllipsis } from '../../utils/format.js'
import type { Output } from './TaskStopTool.js'

/** Stop-task header and result renderers. */

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
    // At most 2 lines, then at most 160 display columns, then trimmed.
    shown = truncateToWidthNoEllipsis(command.split('\n').slice(0, MAX_COMMAND_LINES).join('\n'), MAX_COMMAND_COLUMNS).trim()
  }
  // Whenever the rendered text differs from the raw command — for any
  // reason, including a pure trim — an ellipsis replaces the leading space.
  const suffix = shown !== command ? '… stopped' : ' stopped'
  // The counted receipt, on screen where the stop is visible: how many
  // processes the stop ended, and any pid the bounded reap could not confirm.
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
