// The REPL tool pool: the shared assembler handles the built-in
// set, MCP deny-rule filtering, deduplication and CLI exclusion; the
// caller's extra tools merge on top and WIN deduplication; the result is
// filtered by the permission mode — all through the shared pool owner.

import { useMemo } from 'react'
import type { ToolPermissionContext, Tools } from '../Tool.js'
import { assembleToolPool } from '../tools.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'

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
