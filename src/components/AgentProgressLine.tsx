import React from 'react'
import { Box, Text, type TextProps } from '../ink.js'
import { plural } from '../utils/stringUtils.js'

type AgentProgressLineProps = {
  agentType: string
  name?: string
  description?: string
  color?: TextProps['color']
  descriptionColor?: TextProps['color']
  hideType?: boolean
  model?: string
  toolUseCount: number
  tokensLabel?: string
  statusLine?: string
  lastToolInfo?: string
  isLast: boolean
  isResolved: boolean
  isAsync?: boolean
  isError?: boolean
  shouldAnimate?: boolean
}

export function AgentProgressLine({
  agentType,
  name,
  description,
  color,
  descriptionColor,
  hideType = false,
  model,
  toolUseCount,
  tokensLabel,
  statusLine,
  lastToolInfo,
  isLast,
  isResolved,
  isAsync = false,
}: AgentProgressLineProps): React.ReactNode {
  const connector = isLast ? '└─ ' : '├─ '
  const trunk = isLast ? '   ' : '│  '
  const dim = !isResolved
  const backgrounded = isAsync && isResolved
  const status = statusLine ?? (isResolved ? 'done' : (lastToolInfo ?? 'initialising…'))
  const modelPart = model ? ` · ${model}` : ''
  const toolPart = ` · ${toolUseCount} ${plural(toolUseCount, 'tool use')}`
  const statusDetail = tokensLabel ? `${tokensLabel} · ${status}` : status

  return (
    <Box flexDirection="column">
      <Text dimColor={dim} wrap="truncate-end">
        <Text dimColor>{connector}</Text>
        {hideType ? (
          <>
            <Text bold>{name ?? description ?? agentType}</Text>
            {name !== undefined && description !== undefined && (
              <Text dimColor>{` (${description})`}</Text>
            )}
          </>
        ) : (
          <>
            <Text inverse color={color}>{` ${agentType} `}</Text>
            {description !== undefined && (
              <Text inverse color={descriptionColor ?? color}>{` (${description}) `}</Text>
            )}
          </>
        )}
        {!backgrounded && (
          <Text dimColor>{`${modelPart}${toolPart}`}</Text>
        )}
      </Text>
      {!backgrounded && (
        <Text dimColor={dim} wrap="truncate-end">
          <Text dimColor>{trunk}</Text>
          <Text dimColor>{statusDetail}</Text>
        </Text>
      )}
    </Box>
  )
}

export default AgentProgressLine
