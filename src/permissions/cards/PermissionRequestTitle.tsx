import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import type { Theme } from '../../screen/theme/theme.js'
import { STATE_STYLE } from '../../screen/widgets/theme.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
}

export function PermissionRequestTitle({
  title,
  subtitle,
  color = 'warning',
}: Props): React.ReactNode {  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={color}>
          {`${STATE_STYLE.gated.glyph} `}
          {title}
        </Text>
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
