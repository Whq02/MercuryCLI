import { featureReached } from '../../substrate/featureReached.js'
import { z } from 'zod/v4'

import type { Tool, ToolUseContext } from '../../Tool.js'
import { performMCPOAuthFlow } from '../../services/mcp/auth.js'
import { buildMcpToolName } from '../../utils/mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../utils/mcp/types.js'
import {
  excludeCommandsByServer,
  excludeResourcesByServer,
  excludeToolsByServer,
} from '../../services/mcp/utils.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { clearMcpAuthCache } from '../../services/mcp/client/needsAuth.js'
import { mcpClientForTools } from '../../services/mcp/client/forTools.js'
import { notBuilt } from '../../pi/holes.js'


type McpAuthOutput = {
  message: string
  authUrl?: string
  status: 'auth_url' | 'unsupported' | 'error'
}

const emptyInputSchema = z.object({})

function transportDescription(config: ScopedMcpServerConfig): string {
  const type = config.type ?? 'stdio'
  const url = (config as { url?: string }).url
  return url ? `${type} transport at ${url}` : `${type} transport`
}

export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<typeof emptyInputSchema, McpAuthOutput> {
  return notBuilt('src/tools/McpAuthTool/McpAuthTool.ts:32')
}
