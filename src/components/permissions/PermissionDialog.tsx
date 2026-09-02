import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import type { Theme } from '../../utils/theme.js'
import {
  getModeColor,
  isDefaultMode,
  permissionModeSymbol,
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import { PermissionRequestTitle } from './PermissionRequestTitle.js'
import { PermissionQueueContext } from './PermissionQueueContext.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  titleColor?: keyof Theme
  innerPaddingX?: number
  workerBadge?: WorkerBadgeProps
  titleRight?: React.ReactNode
  children: React.ReactNode
}

export function PermissionDialog({
  title,
  subtitle,
  color = 'warning',
  titleColor,
  innerPaddingX = 1,
  workerBadge,
  titleRight,
  children,
}: Props): React.ReactNode {  const mode = useAppStateMaybeOutsideOfProvider(
    (s: { toolPermissionContext?: { mode?: string } } | undefined) =>
      s?.toolPermissionContext?.mode,
  ) as PermissionMode | undefined
  const modeActive = !isDefaultMode(mode)
  const cardColor: keyof Theme =
    modeActive && mode ? (getModeColor(mode) as keyof Theme) : color
  const modeChip =
    modeActive && mode ? (
      <Text color={getModeColor(mode) as keyof Theme}>
        {permissionModeSymbol(mode) ? `${permissionModeSymbol(mode)} ` : ''}
        {permissionModeTitle(mode).toLowerCase()}
      </Text>
    ) : null
  const queueStatus = React.useContext(PermissionQueueContext)
  const queueMarker =
    queueStatus && queueStatus.total > 1 ? (
      <Text dimColor>
        {queueStatus.position}/{queueStatus.total}
      </Text>
    ) : null
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={cardColor}
      borderLeft={undefined}
      borderRight={undefined}
      borderBottom={undefined}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between" gap={2}>
          <PermissionRequestTitle
            title={title}
            subtitle={subtitle}
            color={titleColor}
            workerBadge={workerBadge}
          />
          <Box flexDirection="row" gap={2} flexShrink={0}>
            {titleRight}
            {queueMarker}
            {modeChip}
          </Box>
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={innerPaddingX}>
        {children}
      </Box>
    </Box>
  )
}
