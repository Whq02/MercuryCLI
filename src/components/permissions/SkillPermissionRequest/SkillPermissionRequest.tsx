import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { SKILL_TOOL_NAME } from '../../../constants/tools/skill.js'
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js'
import { logError } from '../../../utils/log.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../PermissionPrompt.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { notBuilt } from '../../../pi/holes.js'

type SkillOptionValue = 'yes' | 'yes-exact' | 'yes-prefix' | 'no'

export function SkillPermissionRequest(arg0: PermissionRequestProps): React.ReactNode {
  return notBuilt('src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx:27')
}
