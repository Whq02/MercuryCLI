import type { Tool, Tools } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../ExitWorktreeTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { SKILL_TOOL_NAME } from '../SkillTool/constants.js'
import { AGENT_TOOL_NAME, MERCURY_SCOUT_AGENT_TYPE } from './constants.js'

export const SCOUT_SHELL_REFUSAL = `${MERCURY_SCOUT_AGENT_TYPE} is read-only: its shell runs read-only commands only, and it has no editing tool — a command that writes, redirects or changes state is refused.`

export const SCOUT_TOOLS_DESCRIPTION = 'read-only — Read, Glob, Grep, a read-only shell, and every other tool only in the form that reads'

const SCOUT_DENIED_TOOLS: ReadonlySet<string> = new Set([AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME])

export function scoutToolRefusal(toolName: string): string {
  return `${MERCURY_SCOUT_AGENT_TYPE} is read-only: ${toolName} would write or change state here, so the call is refused.`
}

function readsOnly(tool: Tool, input: Record<string, unknown>): boolean {
  try {
    return tool.isReadOnly(input as never) === true
  } catch {
    return false
  }
}

export function scoutRefusal(tool: Tool, input: Record<string, unknown>): string | null {
  if (SCOUT_DENIED_TOOLS.has(tool.name)) return scoutToolRefusal(tool.name)
  if (tool.name === BASH_TOOL_NAME) {
    if (input._simulatedSedEdit !== undefined || input.dangerouslyDisableSandbox === true) return SCOUT_SHELL_REFUSAL
    return readsOnly(tool, input) ? null : SCOUT_SHELL_REFUSAL
  }
  if (tool.name === SKILL_TOOL_NAME) return null
  return readsOnly(tool, input) ? null : scoutToolRefusal(tool.name)
}

export function scoutOffersTool(tool: Tool): boolean {
  if (SCOUT_DENIED_TOOLS.has(tool.name)) return false
  if (tool.name === BASH_TOOL_NAME || tool.name === SKILL_TOOL_NAME) return true
  return readsOnly(tool, {})
}

export function restrictScoutTools(tools: Tools): Tools {
  return tools.filter(scoutOffersTool).map(tool => ({
    ...tool,
    async call(...args: Parameters<Tool['call']>) {
      const refusal = scoutRefusal(tool, args[0])
      if (refusal !== null) throw new Error(refusal)
      return tool.call(...args)
    },
  }))
}
