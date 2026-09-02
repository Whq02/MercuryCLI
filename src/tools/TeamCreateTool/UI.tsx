import * as React from 'react'
import { FAINT, SECOND, TEAL } from '../../components/mercuryPalette.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ThemeName } from '../../utils/theme.js'
import { getResolvedTeammateMode } from '../../utils/swarm/backends/registry.js'
import type { Input, Output } from './TeamCreateTool.js'

// The TeamCreate tool-use line: name + objective (the intent, not the
// filesystem). Streams in as soon as team_name is available.
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  const objective = input.objective ?? input.description
  return `create team: ${input.team_name ?? '…'}${objective ? ` — ${objective}` : ''}`
}

// The result card: a team is a chartered operation, so
// the card shows the charter — objective, lead, operating profile, launch
// backend, and the one next useful action. Filesystem detail stays dim.
export function renderToolResultMessage(
  output: Output,
  _progress: ProgressMessage<ToolProgressData>[],
  _options: { theme: ThemeName },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={TEAL}>{'⊞ '}</Text>
        team <Text bold>{output.team_name}</Text> ready
        <Text color={FAINT}>{` · lead ${output.lead_agent_id} · ${getResolvedTeammateMode()} backend`}</Text>
      </Text>
      <Text color={SECOND} wrap="truncate-end">
        {`  objective: ${output.objective}`}
      </Text>
      <Text color={FAINT}>
        {'  next: TaskCreate the work lanes, then spawn teammates via the Agent tool'}
      </Text>
    </Box>
  )
}

export function extractSearchText(output: Output): string {
  return `team ${output.team_name} ready objective: ${output.objective}`
}
