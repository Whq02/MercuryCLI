import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../kit/tool.js'
import type { ServerResource } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { logMCPError } from '../../platform/logs/errorLog.js'
import { isOutputLineTruncated } from '../kit/truncatedOutput.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './rows.js'
import { mcpClientForTools } from '../../integrations/mcp/client/forTools.js'
import { getDenyRuleForMcpServer } from '../../permissions/rules/decision/rules.js'
import { mcpServerDenyDecision } from '../../permissions/rules/ruleReason.js'


const inputSchema = z.object({
  server: z
    .string()
    .optional()
    .describe('Restrict the listing to one server, by name'),
})

type Input = z.infer<typeof inputSchema>

export type Output = ServerResource[]

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
  userFacingName: () => 'listMcpResources',
  searchHint: 'list resources exposed by connected MCP servers',
  shouldDefer: true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  getToolUseSummary(input?: Partial<Input>) {
    return input?.server ?? 'all servers'
  },
  getActivityDescription(input?: Partial<Input>) {
    return input?.server ? `Listing resources from ${input.server}` : 'Listing MCP resources'
  },
  isResultTruncated(output: Output) {
    return isOutputLineTruncated(JSON.stringify(output, null, 2))
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (input.server !== undefined) {
      const denied = mcpServerDenyDecision(
        context.getAppState().toolPermissionContext,
        LIST_MCP_RESOURCES_TOOL_NAME,
        input.server,
      )
      if (denied) return denied
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
    const permissionContext = context.getAppState().toolPermissionContext
    const allClients = context.options.mcpClients ?? []
    const eligible = allClients.filter(
      client => getDenyRuleForMcpServer(permissionContext, client.name) === null,
    )
    const selected = input.server
      ? eligible.filter(client => client.name === input.server)
      : eligible
    if (input.server && selected.length === 0) {
      const available = eligible.map(client => client.name).join(', ')
      throw new Error(`Server "${input.server}" not found. Available servers: ${available}`)
    }
    const { ensureConnectedClient, fetchResourcesForClient } = mcpClientForTools()
    const groups = await Promise.all(
      selected.map(async (client): Promise<ServerResource[]> => {
        if (client.type !== 'connected') return []
        try {
          const connected = await ensureConnectedClient(client)
          const resources: ServerResource[] = await fetchResourcesForClient(connected)
          return resources
        } catch (error) {
          logMCPError(client.name, error)
          if (input.server) throw error
          return []
        }
      }),
    )
    return { data: groups.flat() }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const content =
      output.length === 0
        ? 'No resources found. Note that MCP servers may still provide tools even when they expose no resources.'
        : JSON.stringify(output)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
})
