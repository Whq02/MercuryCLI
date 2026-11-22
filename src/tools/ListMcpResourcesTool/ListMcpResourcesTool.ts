import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { ServerResource } from '../../utils/mcp/types.js'
import { logMCPError } from '../../utils/log.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import { mcpClientForTools } from '../../services/mcp/client/forTools.js'
import { getDenyRuleForMcpServer } from '../../utils/permissions/decision/rules.js'
import { mcpServerDenyDecision } from '../../utils/permissions/ruleReason.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


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

export const ListMcpResourcesTool: Unbuilt = unbuilt('src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts:35')
