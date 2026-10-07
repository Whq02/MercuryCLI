import type { Tool, ToolUseContext } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { getDestructiveCommandWarning } from '../../tools/BashTool/destructiveCommandWarning.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { resolve } from 'node:path'
import { getCwd } from '../cwd.js'
import { hasWildcards, suggestionForExactCommand } from './shellRuleMatching.js'

export const FLOW_AWAY_TIMEOUT_MS = 5 * 60_000
export const FLOW_AWAY_MESSAGE = 'the user is away; continue with an allowed tool call instead'

export function flowRequiresFreshApproval(tool: Tool, input: Record<string, unknown>): boolean {
  try {
    return tool.isDestructive?.(input) === true ||
      (tool.name === BASH_TOOL_NAME && typeof input.command === 'string' && getDestructiveCommandWarning(input.command) !== null)
  } catch {
    return true
  }
}

export function flowUserAllowUpdates(
  tool: Tool,
  input: Record<string, unknown>,
  context: Partial<Pick<ToolUseContext, 'getAppState'>>,
  updates: PermissionUpdate[],
  suggestions: PermissionUpdate[] = [],
): PermissionUpdate[] {
  if (context.getAppState?.().toolPermissionContext.mode !== 'flow') return updates
  if (flowRequiresFreshApproval(tool, input)) return updates.filter(update => update.type === 'removeRules')
  if (updates.length > 0) return updates
  if (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) {
    const command = input.command
    if (typeof command !== 'string' || command.trim() === '' || hasWildcards(command)) return []
    return suggestionForExactCommand(tool.name, command)
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool.name)) {
    const path = tool.getPath?.(input)
    if (!path || /[!*?\[\]{}\n\r]/.test(path)) return []
    const absolute = resolve(getCwd(), path).replace(/\\/g, '/')
    const drive = /^([A-Za-z]):\/(.*)$/.exec(absolute)
    const content = drive ? `//${drive[1]!.toUpperCase()}/${drive[2]}` : `/${absolute}`
    return [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: tool.name === 'Read' ? 'Read' : 'Edit', ruleContent: content }] }]
  }
  return suggestions.flatMap(update => {
    if (update.type !== 'addRules' || update.behavior !== 'allow') return []
    const rules = update.rules.filter(rule => rule.ruleContent !== undefined && rule.ruleContent.trim() !== '' && !hasWildcards(rule.ruleContent))
    return rules.length === update.rules.length && rules.length > 0
      ? [{ ...update, destination: 'localSettings' as const }]
      : []
  })
}
