import type { Tool, Tools } from '../kit/tool.js'
import { findToolByName } from '../kit/tool.js'
import { displayToolName } from '../../engine/tool-dispatch/toolNameDisplay.js'
import { MCPTool } from './MCPTool.js'

const shims = new Map<string, Tool>()

function absentToolShim(name: string): Tool {
  const cached = shims.get(name)
  if (cached) return cached
  const shim: Tool = {
    ...MCPTool,
    name,
    userFacingName: () => displayToolName(name),
    async call(): Promise<never> {
      throw new Error(`the tool "${displayToolName(name)}" is no longer available in this session`)
    },
  }
  shims.set(name, shim)
  return shim
}

export function findToolForRender(tools: Tools, name: string): Tool {
  return findToolByName(tools, name) ?? absentToolShim(name)
}
