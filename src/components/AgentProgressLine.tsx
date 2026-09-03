// One subagent's two-row progress entry under the agent fold. A task counts
// as BACKGROUNDED when it is asynchronous and resolved: its tail and second
// row are omitted (the "continues in the background" status branch is
// deliberately unreachable — kept, not wired). The error and animation props
// are accepted and unread, byte-for-byte with the shipped surface.

import React from 'react'
import { Box, Text } from '../ink.js'
import { formatTokens } from '../utils/format.js'
import { plural } from '../utils/stringUtils.js'

export type AgentProgressLineProps = {
  agentType: string
  description?: string
  name?: string
  descriptionColor?: string
  taskDescription?: string
  /** The model the agent runs (the crew record's own spelling). */
  model?: string
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
  /** The row's own status line (the crew record's state word beside its
   *  elapsed time) — painted running or settled, in place of the derived
   *  "last tool" / "done" words. */
  statusLine?: string
}

export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  model,
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
  statusLine,
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
      {model !== undefined ? `· ${model} ` : ''}
      · {toolUseCount} {plural(toolUseCount, 'tool use')}
      {tokens !== undefined ? ` · ${formatTokens(tokens)} tokens` : ''}
    </Text>
  )

  // The status branch naming taskDescription / continuing in the background
  // exists but is unreachable: backgrounded rows omit the row itself.
  const status = backgrounded
    ? taskDescription
      ? `${taskDescription} continues in the background`
      : 'continues in the background'
    : statusLine !== undefined
      ? statusLine
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
