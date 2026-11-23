import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../kit/tool.js'
import type { MCPProgress } from '../kit/toolProgress.js'
import { lazySchema } from '../../platform/primitives/lazySchema.js'
import { isOutputLineTruncated } from '../kit/truncatedOutput.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './rows.js'

export const inputSchema = lazySchema(() => z.looseObject({}))
export const outputSchema = lazySchema(() => z.string().describe('The MCP call\'s pass-through result text'))
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
  name: 'mcp',
  userFacingName: () => 'mcp',
  isMcp: true,
  isOpenWorld: () => false,
  maxResultSizeChars: 100_000,
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  ...presentation,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async checkPermissions() {
    return { behavior: 'passthrough' as const, message: 'MCP tool requires permission' }
  },
  call: requireClone,
} satisfies ToolDef<ReturnType<typeof inputSchema>, Output, MCPProgress>)
