import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from '../../services/mcp/client.js'
import type { ServerResource } from '../../services/mcp/types.js'
import { logMCPError } from '../../utils/log.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/**
 * Lists MCP resources across connected servers, optionally filtered to one.
 * One server's reconnect failure never sinks the whole result.
 */

// The only non-strict schema in this tool family.
const inputSchema = z.object({
  server: z
    .string()
    .optional()
    .describe('Restrict the listing to one server, by name'),
})

type Input = z.infer<typeof inputSchema>

export type Output = ServerResource[]

// Resumed transcripts guard persisted results through this schema; loose
// objects keep every standard MCP resource field.
const outputSchema = z.array(
  z.looseObject({
    uri: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
    description: z.string().optional(),
    server: z.string(),
  }),
)

export const ListMcpResourcesTool = buildTool({
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  userFacingName: () => 'listMcpResources',
  toAutoClassifierInput(input: Input): string {
    return input.server ?? ''
  },
  getToolUseSummary(input?: Partial<Input>): string | null {
    return input?.server ?? 'all servers'
  },
  getActivityDescription(input?: Partial<Input>): string {
    return input?.server ? `Listing resources from ${input.server}` : 'Listing MCP resources'
  },
  async description(): Promise<string> {
    return DESCRIPTION
  },
  async prompt(): Promise<string> {
    return PROMPT
  },
  async call(input: Input, context: ToolUseContext) {
    const clients = context.options.mcpClients
    // The filter is on NAME alone, before any connection-state test — a
    // known-but-disconnected server yields an empty list, not the error.
    const selected = input.server
      ? clients.filter(client => client.name === input.server)
      : clients
    if (input.server && selected.length === 0) {
      throw new Error(
        `Server "${input.server}" not found. Available servers: ${clients.map(client => client.name).join(', ')}`,
      )
    }
    const perClient = await Promise.all(
      selected.map(async client => {
        if (client.type !== 'connected') return []
        try {
          const live = await ensureConnectedClient(client)
          return await fetchResourcesForClient(live)
        } catch (err) {
          logMCPError(client.name, err)
          return []
        }
      }),
    )
    return { data: perClient.flat() satisfies Output }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    if (data.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content:
          'No resources found. Note that MCP servers may still provide tools even when they expose no resources.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: JSON.stringify(data),
    }
  },
  isResultTruncated(data: Output): boolean {
    return isOutputLineTruncated(JSON.stringify(data, null, 2))
  },
  renderToolUseMessage,
  renderToolResultMessage,
})
