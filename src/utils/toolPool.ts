import { isMcpTool } from '../services/mcp/utils.js'
import type { Tool } from '../Tool.js'
import { SET_TIER_TOOL_NAME } from '../tools/SetTierTool/constants.js'
import type { PermissionMode } from '../types/permissions.js'

/**
 * Merges and mode-filters the available tool list. Deliberately free of
 * any UI-framework dependency so the non-interactive entrypoint can import
 * it without pulling the renderer into its module graph.
 */

const byName = (a: Tool, b: Tool): number => a.name.localeCompare(b.name)

/**
 * The caller-supplied list is concatenated first, so its tools win the
 * per-name dedupe. The merged list is then partitioned into built-in and
 * MCP halves, each sorted, and re-joined built-ins first — the server
 * caches by prefix, so the built-in block must come first and keep a
 * deterministic order from turn to turn (cache stability: a per-turn
 * re-ordering is a classic cache-buster).
 */
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

  // Pool visibility only — call-time authority stays in the tool's own
  // input validation. Callers re-merge on permission-context changes, so a
  // mode change reaches the pool at the next render.
  if (mode !== 'autopilot') {
    return ordered.filter(tool => tool.name !== SET_TIER_TOOL_NAME)
  }
  return ordered
}
