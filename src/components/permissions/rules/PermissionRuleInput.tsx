import * as React from 'react'
import { exitChordNoticeText } from '../../PromptInput/ExitChordNotice.js'
import { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import TextInput from '../../TextInput.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../../utils/permissions/permissionRuleParser.js'
import type { PermissionBehavior, PermissionRuleValue } from '../../../types/permissions.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type PermissionRuleInputProps = Unbuilt

export function PermissionRuleInput(arg0: PermissionRuleInputProps): React.ReactNode {
  return notBuilt('src/components/permissions/rules/PermissionRuleInput.tsx:23')
}
