import { resolve } from 'node:path'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../../../hooks/effects.js'
import { Box, Text } from '../../../ink.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import {
  getFirstWordPrefix,
  getSimpleCommandPrefix,
} from '../../../tools/BashTool/bashPermissions.js'
import { getDestructiveCommandWarning } from '../../../utils/shell/destructiveCommandWarning.js'
import { parseSedEditCommand } from '../../../tools/BashTool/sedEditParser.js'
import { getCompoundCommandPrefixesStatic } from '../../../utils/bash/prefix.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { expandPath, toTildePath } from '../../../utils/path.js'
import { getFocusedWorkspaceCwd, getFocusedWorkspaceOriginalCwd, useFocusedWorkspaceCwd, useFocusedWorkspaceOriginalCwd } from '../../../hooks/useFocusedWorkspaceCwd.js'
import type { Message } from '../../../types/message.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js'
import {
  PermissionExplainerContent,
  usePermissionExplainerUI,
} from '../PermissionExplanation.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { SedEditPermissionRequest } from '../SedEditPermissionRequest/SedEditPermissionRequest.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { bashToolUseOptions, type BashToolUseOption } from './bashToolUseOptions.js'
import { passedOver } from '../../../utils/passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

type BashCardInput = { command: string; cwd?: string }

function suggestedBashRuleContents(suggestions: PermissionUpdate[]): string[] {
  const contents: string[] = []
  for (const update of suggestions) {
    if (update.type !== 'addRules') continue
    for (const rule of update.rules) {
      if (rule.toolName === BASH_TOOL_NAME && rule.ruleContent) contents.push(rule.ruleContent)
    }
  }
  return contents
}

export function BashPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm } = props
  const input = BashTool.inputSchema.parse(toolUseConfirm.input) as BashCardInput

  const sedEditInfo = parseSedEditCommand(input.command)
  if (sedEditInfo !== null) {
    const shellCwd = toolUseConfirm.cwd ?? (input.cwd === undefined ? getFocusedWorkspaceCwd() : resolve(getFocusedWorkspaceOriginalCwd(), input.cwd))
    const resolved = { ...sedEditInfo, filePath: expandPath(sedEditInfo.filePath, shellCwd) }
    return <SedEditPermissionRequest {...props} sedEditInfo={resolved} />
  }
  return <BashCommandPermissionRequest {...props} command={input.command} cwd={input.cwd} />
}

export function MonitorPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { command, description } = props.toolUseConfirm.input as { command?: unknown; description?: unknown }
  return (
    <BashCommandPermissionRequest
      {...props}
      command={typeof command === 'string' ? command : ''}
      title="Monitor command"
      summary={typeof description === 'string' ? description : ''}
    />
  )
}

function BashCommandPermissionRequest(
  props: PermissionRequestProps & { command: string; cwd?: string; title?: string; summary?: string },
): React.ReactNode {
  return notBuilt('src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:76')
}
