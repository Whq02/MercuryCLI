import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import type { MCPProgress } from '../../types/tools.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'


export type { MCPProgress }

export const inputSchema = lazySchema(() => z.looseObject({}))
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.string().describe('The MCP call\'s pass-through result text'),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MCPTool = buildTool({
  name: 'mcp',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isMcp: true,
  isOpenWorld: () => false,
  userFacingName: () => 'mcp',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async checkPermissions() {
    return {
      behavior: 'passthrough' as const,
      message: 'MCP tool requires permission',
    }
  },
  async call() {
    throw new Error('MCP tool shell was called directly — the client must clone it per discovered tool')
  },
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(output)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output,
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output, MCPProgress>)
