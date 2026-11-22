import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../../../hooks/effects.js'
import { Box, Text } from '../../../ink.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { PowerShellTool } from '../../../tools/PowerShellTool/PowerShellTool.js'
import { POWERSHELL_TOOL_NAME } from '../../../constants/tools/powershell.js'
import { isAllowlistedCommand } from '../../../tools/PowerShellTool/readOnlyValidation.js'
import { getCompoundCommandPrefixesStatic } from '../../../utils/powershell/staticPrefix.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import type { Message } from '../../../types/message.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js'
import {
  PermissionExplainerContent,
  usePermissionExplainerUI,
} from '../PermissionExplanation.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import {
  powershellToolUseOptions,
  type PowerShellToolUseOption,
} from './powershellToolUseOptions.js'
import { passedOver } from '../../../utils/passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

type PowerShellCardInput = { command: string }

export function PowerShellPermissionRequest(arg0: PermissionRequestProps): React.ReactNode {
  return notBuilt('src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx:33')
}
