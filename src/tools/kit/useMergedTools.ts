import { useMemo } from 'react'
import type { ToolPermissionContext, Tools } from './tool.js'
import { assembleToolPool } from './toolList.js'
import { mergeAndFilterTools } from '../../engine/tool-dispatch/toolPool.js'

export function useMergedTools(
  initialTools: Tools,
  mcpTools: Tools,
  toolPermissionContext: ToolPermissionContext,
): Tools {
  return useMemo(() => {
    const assembled = assembleToolPool(toolPermissionContext, mcpTools)
    return mergeAndFilterTools(initialTools, assembled, toolPermissionContext.mode)
  }, [initialTools, mcpTools, toolPermissionContext])
}
