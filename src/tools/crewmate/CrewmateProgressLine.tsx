import React from 'react'
import { Box, Text, type TextProps } from '../../screen/themedRenderer.js'
import { plural } from '../../platform/text/strings.js'

type CrewmateProgressLineProps = {
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

export function CrewmateProgressLine({
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
}: CrewmateProgressLineProps): React.ReactNode {
  const connector = isLast ? '└─ ' : '├─ '
  const trunk = isLast ? '   ' : '│  '
  const dim = !isResolved
  const backgrounded = isAsync && isResolved
  const status = backgrounded
    ? description
      ? `${description} continues in the background`
      : 'continues in the background'
    : (statusLine ?? (isResolved ? 'done' : (lastToolInfo ?? 'initialising…')))
  const modelPart = model ? ` · ${model}` : ''
  const toolPart = ` · ${toolUseCount} ${plural(toolUseCount, 'tool use')}`

  return (
    <Box flexDirection="column">
      <Text dimColor={dim} wrap="truncate-end">
        <Text dimColor>{connector}</Text>
        {hideType ? (
          <>
            <Text bold dimColor={dim}>
              {name ?? description ?? agentType}
            </Text>
            {name !== undefined && description !== undefined && (
              <Text dimColor>{` (${description})`}</Text>
            )}
          </>
        ) : (
          <>
            <Text inverse color={color} dimColor={dim}>{` ${agentType} `}</Text>
            {description !== undefined && (
              <Text inverse color={descriptionColor ?? color} dimColor={dim}>
                {` (${description}) `}
              </Text>
            )}
          </>
        )}
        {!backgrounded && (
          <Text dimColor>{`${modelPart}${toolPart}`}</Text>
        )}
      </Text>
      {!backgrounded && (
        <Text dimColor wrap="truncate-end">
          {trunk}
          {tokensLabel ? `${tokensLabel} · ` : ''}
          {status}
        </Text>
      )}
    </Box>
  )
}

export default CrewmateProgressLine
