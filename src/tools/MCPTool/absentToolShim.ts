/**
 * Render-side shim for a tool that has LEFT the live registry (sweep
 * #2, packet 66). A transcript row — a tool use, its error, its result —
 * outlives the roster: an MCP server disconnecting, a config edit, or a
 * resume without that server must not make history rows vanish. The shim
 * carries the recorded name and the generic MCP renderers, so the row keeps
 * painting exactly as absence-honest chrome; it is for RENDER ONLY — its
 * call throws by construction and it is never admitted to a tool pool.
 */
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

/**
 * The render lookup: the live tool when it exists, the absence shim when it
 * does not. Execution paths keep using findToolByName — absence there is a
 * typed refusal, never a shim.
 */
export function findToolForRender(tools: Tools, name: string): Tool {
  return findToolByName(tools, name) ?? absentToolShim(name)
}
