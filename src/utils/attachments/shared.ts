
import type { ToolPermissionContext } from '../../Tool.js'
import { matchingRuleForInput } from '../permissions/filesystem.js'

export function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(
    filePath,
    toolPermissionContext,
    'read',
    'deny',
  )
  return denyRule !== null
}
