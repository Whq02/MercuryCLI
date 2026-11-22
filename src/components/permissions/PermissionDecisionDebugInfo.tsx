import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Ansi } from '../../ink/Ansi.js'
import { StatusIcon } from '../design-system/StatusIcon.js'
import { STATE_STYLE } from '../mercury-ui/theme.js'
import { useAppState } from '../../state/AppState.js'
import { detectUnreachableRules } from '../../utils/permissions/shadowedRuleDetection.js'
import { ruleSourceWords } from '../../utils/permissions/ruleReason.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionRuleValue, PermissionUpdate } from '../../types/permissions.js'
import { BYPASSED_ASK_ROAD_WORDS } from '../../types/permissions.js'
import { notBuilt } from '../../pi/holes.js'

function DebugRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box gap={1}>
      <Box width={10} flexShrink={0} justifyContent="flex-end">
        <Text dimColor wrap="truncate-end">{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  )
}

function ruleValuesOf(updates: PermissionUpdate[] | undefined): PermissionRuleValue[] {
  const values: PermissionRuleValue[] = []
  for (const update of updates ?? []) {
    if (update.type === 'addRules') values.push(...update.rules)
  }
  return values
}

type SetModeUpdate = Extract<PermissionUpdate, { type: 'setMode' }>
function lastModeOf(updates: PermissionUpdate[] | undefined): SetModeUpdate['mode'] | undefined {
  let mode: SetModeUpdate['mode'] | undefined
  for (const update of updates ?? []) {
    if (update.type === 'setMode') mode = update.mode
  }
  return mode
}

export function PermissionDecisionDebugInfo(arg0: {
  permissionResult: PermissionDecision | PermissionResult
  toolName?: string
}): React.ReactNode {
  return notBuilt('src/components/permissions/PermissionDecisionDebugInfo.tsx:144')
}
