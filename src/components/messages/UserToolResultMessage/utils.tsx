
import { useMemo } from 'react'
import { type Tool, type Tools } from '../../../Tool.js'
import { findToolForRender } from '../../../tools/MCPTool/absentToolShim.js'
import type { ToolUseBlockParam } from '../../../types/wire.js'
import type { MessageLookups } from '../../../utils/messages/lookups.js'

export function useGetToolFromMessages(
  toolUseID: string,
  tools: Tools,
  lookups: MessageLookups,
): { tool: Tool; toolUse: ToolUseBlockParam } | null {
  return useMemo(() => {
    const toolUse = lookups.toolUseByToolUseID.get(toolUseID)
    if (!toolUse) return null
    return { tool: findToolForRender(tools, toolUse.name), toolUse }
  }, [toolUseID, tools, lookups])
}
