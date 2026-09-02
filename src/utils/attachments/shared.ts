
import type { ContentBlockParam } from '../../types/wire.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { matchingRuleForInput } from '../permissions/filesystem.js'

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

export function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResultBlock).type === 'tool_result' &&
    typeof (b as ToolResultBlock).tool_use_id === 'string'
  )
}

export function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isToolResultBlock)
}

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
