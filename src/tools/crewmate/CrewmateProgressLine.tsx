import React from 'react'
import { Box, Text, type TextProps } from '../../screen/themedRenderer.js'

type CrewmateProgressLineProps = {
  agentType: string
  name?: string
  description?: string
  color?: TextProps['color']
  descriptionColor?: TextProps['color']
  hideType?: boolean
  model?: string
  timeWords?: string
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
  timeWords,
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
    : timeWords !== undefined
      ? statusLine
      : (statusLine ?? (isResolved ? 'done' : (lastToolInfo ?? 'initialising…')))
  const modelPart = model ? ` · ${model}` : ''
  const timePart = timeWords ? ` · ${timeWords}` : ''
  const secondLineParts = [tokensLabel, status].filter(
    (part): part is string => part !== undefined && part !== '',
  )

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
        {!backgrounded && (modelPart !== '' || timePart !== '') && (
          <Text dimColor>{`${modelPart}${timePart}`}</Text>
        )}
      </Text>
      {!backgrounded && (
        <Text dimColor wrap="truncate-end">
          {trunk}
          {secondLineParts.join(' · ')}
        </Text>
      )}
    </Box>
  )
}

export default CrewmateProgressLine
