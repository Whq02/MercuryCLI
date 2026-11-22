import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { resolveThemeName } from './resolveThemeName.js'
import { DEBUG_TOOL_NAME } from '../../constants/tools/debug.js'
import { EVAL_TOOL_NAME } from '../../tools/EvalTool/constants.js'
import type { Tool } from '../../Tool.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { ConsentBodyText } from './ConsentBodyText.js'
import { PermissionDialog } from './PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from './PermissionPrompt.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from './hooks.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { notBuilt } from '../../pi/holes.js'

const MCP_SUFFIX = ' (MCP)'
const RUNS_PROJECT_PROGRAMS: ReadonlySet<string> = new Set([DEBUG_TOOL_NAME, EVAL_TOOL_NAME, 'Launch', 'Test'])

type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function FallbackPermissionRequest(arg0: PermissionRequestProps & { title?: string; body?: React.ReactNode; screen?: 'MediaPermissionRequest' }): React.ReactNode {
  return notBuilt('src/components/permissions/FallbackPermissionRequest.tsx:38')
}
