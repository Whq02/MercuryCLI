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

/**
 * The generic MCP tool SHELL: a passthrough-permission template registered
 * under the placeholder name `mcp` and never called with that identity. The
 * MCP client clones it per discovered tool and replaces the identity-bearing
 * members (name, user-facing name, description, prompt, open-world answer,
 * call, permission check) and installs the server's own schema, provenance,
 * search hint, annotation-derived answers and the collapse classifier.
 * Everything else — the zod schemas, the result-size cap, truncation
 * reporting, renderers, result mapping — is inherited from here.
 */

/** Re-exported from the central types module so importers do not create a cycle. */
export type { MCPProgress }

// MCP servers publish their own JSON schema, which the client installs on
// the clone; the zod form must never reject anything.
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
  // Defers to the generic rule engine rather than deciding itself; the
  // per-tool clone overrides this with a policy re-check and a rule
  // suggestion.
  async checkPermissions() {
    return {
      behavior: 'passthrough' as const,
      message: 'MCP tool requires permission',
    }
  },
  async call() {
    // The clone always supplies the real call; the shell is never invoked.
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
