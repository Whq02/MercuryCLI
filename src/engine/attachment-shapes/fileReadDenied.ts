import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import { matchingRuleForInput } from '../../permissions/rules/filesystem.js'

export function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  return matchingRuleForInput(filePath, toolPermissionContext, 'read', 'deny') !== null
}
