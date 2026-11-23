import { isMcpTool } from '../../integrations/mcp/utils.js'
import type { Tool } from '../../tools/kit/tool.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'


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
  return ordered
}
