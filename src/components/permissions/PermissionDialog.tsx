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

/**
 * The shared consent shell for every tool approval.
 *
 * Fork: the Mercury CONSENT CARD — a full round card whose border carries the
 * ACTIVE PERMISSION MODE's color (default → the AMBER attention role · plan →
 * planMode/info · implement → autoAccept/amber · sovereign → error), with a
 * right-aligned mode chip in the header when a non-default mode is active. The
 * moment the harness asks for trust reads as one coherent Mercury artifact,
 * and the mode thread (input border → consent border) matches MercuryFrame's
 * modeBand vocabulary (the shared PermissionMode helpers — one source).
 * A bare stamp keeps its top-only round rule. No new hex: every color here is a
 * theme ROLE, so the warm-ink overlay + light/ansi themes resolve it.
 *
 * default-mode consent moved from the identity `permission`
 * role to the fixed `warning` spine — waiting on an operator decision IS the
 * needs-attention state, and it must never share a hue with identity (the
 * pre-AURORA card was indistinguishable from the wordmark/prompt red).
 */
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
  // Non-default mode tints the whole card; default keeps the accent role the
  // caller passed (`permission` unless a body overrides, e.g. plan-approval).
  const cardColor: keyof Theme =
    modeActive && mode ? (getModeColor(mode) as keyof Theme) : color
  const modeChip =
    modeActive && mode ? (
      <Text color={getModeColor(mode) as keyof Theme}>
        {permissionModeSymbol(mode) ? `${permissionModeSymbol(mode)} ` : ''}
        {permissionModeTitle(mode).toLowerCase()}
      </Text>
    ) : null
  // Queue-position marker: a stacked consent sequence must not masquerade as
  // a single request. When >1 request is in play this renders a faint `n/N`
  // beside the mode chip; a lone request keeps the card byte-identical.
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
