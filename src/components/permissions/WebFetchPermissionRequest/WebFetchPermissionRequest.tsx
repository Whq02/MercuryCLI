import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { notBuilt } from '../../../pi/holes.js'

type FetchOptionValue = 'yes' | 'yes-dont-ask-domain' | 'no'

function domainRuleContent(input: unknown): string {
  try {
    const parsed = WebFetchTool.inputSchema.safeParse(input)
    if (!parsed.success) return `input:${String(input)}`
    const { url } = parsed.data as { url: string }
    return `domain:${new URL(url).hostname}`
  } catch {
    return `input:${String(input)}`
  }
}

export function WebFetchPermissionRequest(arg0: PermissionRequestProps): React.ReactNode {
  return notBuilt('src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx:26')
}
