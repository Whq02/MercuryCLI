import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { approvalScopeWords, checkedRuleContent, crossingScopeWords } from '../../../services/browser/browserWords.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { notBuilt } from '../../../pi/holes.js'

type BrowserOptionValue = 'yes' | 'yes-dont-ask-origin' | 'no'


export function BrowserPermissionRequest(arg0: PermissionRequestProps): React.ReactNode {
  return notBuilt('src/components/permissions/BrowserPermissionRequest/BrowserPermissionRequest.tsx:17')
}
