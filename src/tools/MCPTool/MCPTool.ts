import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { MCPProgress } from '../../types/tools.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'

export type { MCPProgress }
const inputSchema = lazySchema(() => z.looseObject({}))
const outputSchema = lazySchema(() => z.string().describe('The MCP call\'s pass-through result text'))
type Output = z.infer<ReturnType<typeof outputSchema>>

async function requireClone(): Promise<never> {
  throw new Error('MCP tool shell was called directly — the client must clone it per discovered tool')
}

const presentation = {
  renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage,
  isResultTruncated: (output: Output) => isOutputLineTruncated(output),
  mapToolResultToToolResultBlockParam: (content: Output, tool_use_id: string) => ({ type: 'tool_result' as const, tool_use_id, content }),
}

export const MCPTool = buildTool({
  ...presentation,
  call: requireClone,
  checkPermissions: async () => ({ behavior: 'passthrough' as const, message: 'MCP tool requires permission' }),
  description: async () => DESCRIPTION,
  prompt: async () => PROMPT,
  userFacingName: () => 'mcp',
  isOpenWorld: () => false,
  isMcp: true,
  name: 'mcp',
  maxResultSizeChars: 100_000,
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },
} satisfies ToolDef<ReturnType<typeof inputSchema>, Output, MCPProgress>)
