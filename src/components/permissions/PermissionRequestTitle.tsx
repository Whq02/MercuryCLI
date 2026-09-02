import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
import { STATE_STYLE } from '../mercury-ui/theme.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  workerBadge?: WorkerBadgeProps
}

// a consent/question title WAITS on the operator — the
// fixed AMBER attention role, never the identity accent (the ▲ gated glyph
// already carries the state without color).
export function PermissionRequestTitle({
  title,
  subtitle,
  color = 'warning',
  workerBadge,
}: Props): React.ReactNode {  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={color}>
          {`${STATE_STYLE.gated.glyph} `}
          {title}
        </Text>
        {workerBadge && (
          <Text color={'subtle'} dimColor={false}>
            {'· '}@{workerBadge.name}
          </Text>
        )}
      </Box>
      {subtitle != null &&
        (typeof subtitle === 'string' ? (
          <Text
            color={'subtle'}
            dimColor={false}
            wrap="truncate-start"
          >
            {subtitle}
          </Text>
        ) : (
          subtitle
        ))}
    </Box>
  )
}
