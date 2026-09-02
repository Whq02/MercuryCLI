// One subagent's two-row progress entry under the agent fold. A task counts
// as BACKGROUNDED when it is asynchronous and resolved: its tail and second
// row are omitted (the "continues in the background" status branch is
// deliberately unreachable — kept, not wired). The error and animation props
// are accepted and unread, byte-for-byte with the shipped surface.

import React from 'react'
import { Box, Text } from '../ink.js'
import { formatNumber } from '../utils/format.js'
import { plural } from '../utils/stringUtils.js'

export type AgentProgressLineProps = {
  agentType: string
  description?: string
  name?: string
  descriptionColor?: string
  taskDescription?: string
  toolUseCount: number
  tokens?: number
  color?: string
  isLast: boolean
  isResolved: boolean
  isError?: boolean
  isAsync?: boolean
  shouldAnimate?: boolean
  lastToolInfo?: string
  hideType?: boolean
}

export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  toolUseCount,
  tokens,
  color,
  isLast,
  isResolved,
  isError,
  isAsync = false,
  shouldAnimate,
  lastToolInfo,
  hideType = false,
}: AgentProgressLineProps): React.ReactNode {
  void isError
  void shouldAnimate

  const backgrounded = isAsync && isResolved
  const connector = isLast ? '└─ ' : '├─ '
  const dim = !isResolved

  const identity = hideType ? (
    <Text bold dimColor={dim}>
      {name ?? description ?? agentType}
      {name && description ? <Text dimColor> ({description})</Text> : null}
    </Text>
  ) : (
    <>
      <Text inverse color={color} dimColor={dim}>
        {' '}
        {agentType}{' '}
      </Text>
      {description ? (
        <Text inverse color={descriptionColor ?? color} dimColor={dim}>
          {' '}
          ({description}){' '}
        </Text>
      ) : null}
    </>
  )

  const tail = backgrounded ? null : (
    <Text dimColor>
      {' '}
      · {toolUseCount} {plural(toolUseCount, 'tool use')}
      {tokens !== undefined ? ` · ${formatNumber(tokens)} tokens` : ''}
    </Text>
  )

  // The status branch naming taskDescription / continuing in the background
  // exists but is unreachable: backgrounded rows omit the row itself.
  const status = backgrounded
    ? taskDescription
      ? `${taskDescription} continues in the background`
      : 'continues in the background'
    : !isResolved
      ? (lastToolInfo ?? 'initialising…')
      : 'done'

  return (
    <Box flexDirection="column">
      <Text dimColor={dim} wrap="truncate-end">
        <Text dimColor>{connector}</Text>
        {identity}
        {tail}
      </Text>
      {backgrounded ? null : (
        <Text dimColor wrap="truncate-end">
          {isLast ? '   ' : '│  '}
          {status}
        </Text>
      )}
    </Box>
  )
}

export default AgentProgressLine
