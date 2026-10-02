import type { Tool, Tools } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { MERCURY_SCOUT_AGENT_TYPE } from './constants.js'

export const SCOUT_SHELL_REFUSAL = `${MERCURY_SCOUT_AGENT_TYPE} is read-only: its shell runs read-only commands only, and it has no editing tool — a command that writes, redirects or changes state is refused.`

export function scoutRefusal(tool: Tool, input: Record<string, unknown>): string | null {
  if (tool.name !== BASH_TOOL_NAME) return null
  if (input._simulatedSedEdit !== undefined || input.dangerouslyDisableSandbox === true) return SCOUT_SHELL_REFUSAL
  return tool.isReadOnly(input) ? null : SCOUT_SHELL_REFUSAL
}

export function restrictScoutTools(tools: Tools): Tools {
  return tools.map(tool =>
    tool.name !== BASH_TOOL_NAME
      ? tool
      : {
          ...tool,
          async call(...args: Parameters<Tool['call']>) {
            const refusal = scoutRefusal(tool, args[0])
            if (refusal !== null) throw new Error(refusal)
            return tool.call(...args)
          },
        },
  )
}
