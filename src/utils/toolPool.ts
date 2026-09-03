import { isMcpTool } from '../services/mcp/utils.js'
import type { Tool } from '../Tool.js'
import { SET_TIER_TOOL_NAME } from '../tools/SetTierTool/constants.js'
import type { PermissionMode } from '../types/permissions.js'


const byName = (a: Tool, b: Tool): number => a.name.localeCompare(b.name)

export function mergeAndFilterTools(
  initialTools: readonly Tool[],
  assembled: readonly Tool[],
  mode: PermissionMode,
): Tool[] {
  const seenNames = new Set<string>()
  const merged: Tool[] = []
  for (const tool of [...initialTools, ...assembled]) {
    if (seenNames.has(tool.name)) continue
    seenNames.add(tool.name)
    merged.push(tool)
  }

  const builtinTools = merged.filter(tool => !isMcpTool(tool)).sort(byName)
  const mcpTools = merged.filter(tool => isMcpTool(tool)).sort(byName)
  const ordered = [...builtinTools, ...mcpTools]

  void mode
  void SET_TIER_TOOL_NAME
  return ordered
}
