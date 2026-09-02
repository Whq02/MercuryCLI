// Tool resolution for result rows: given a tool-use id, recover both the
// tool-use block (from the lookups) and the Tool (from the registry) — or
// nothing when either half is missing (old transcripts, retired tools).

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
    // The absence shim keeps a recorded result row rendering after its tool
    // leaves the live registry (sweep #2, packet 66).
    return { tool: findToolForRender(tools, toolUse.name), toolUse }
  }, [toolUseID, tools, lookups])
}
