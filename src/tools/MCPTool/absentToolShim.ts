import type { Tool, Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import { MCPTool } from './MCPTool.js'

const shims = new Map<string, Tool>()

function absentToolShim(name: string): Tool {
  const cached = shims.get(name)
  if (cached) return cached
  const shim = {
    ...(MCPTool as unknown as Tool),
    name,
    userFacingName: () => name,
    async call(): Promise<never> {
      throw new Error(`the tool "${name}" is no longer available in this session`)
    },
  } as unknown as Tool
  shims.set(name, shim)
  return shim
}

export function findToolForRender(tools: Tools, name: string): Tool {
  return findToolByName(tools, name) ?? absentToolShim(name)
}
