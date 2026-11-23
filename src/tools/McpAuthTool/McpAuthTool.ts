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
  const descriptionText = [
    `The MCP server "${serverName}" (${transportDescription(config)}) is installed but requires authentication before its tools can be used.`,
    'Calling this tool starts the OAuth flow and returns an authorization URL to share with the user.',
    "Once the user authorizes in their browser, the server's real tools become available automatically.",
  ].join(' ')

  async function reconnectAfterAuth(
    setAppState: ToolUseContext['setAppState'] | undefined,
  ): Promise<void> {
    try {
      clearMcpAuthCache()
      const report = await mcpClientForTools().reconnectMcpServerImpl(serverName, config)
      if (setAppState) {
        setAppState(prev => {
          const hasClient = prev.mcp.clients.some(c => c.name === serverName)
          const clients = hasClient
            ? prev.mcp.clients.map(c => (c.name === serverName ? report.client : c))
            : [...prev.mcp.clients, report.client]
          const tools = [...excludeToolsByServer(prev.mcp.tools, serverName), ...report.tools]
          const commands = [
            ...excludeCommandsByServer(prev.mcp.commands, serverName),
            ...report.commands,
          ]
          const resources = excludeResourcesByServer(prev.mcp.resources, serverName)
          if (report.resources && report.resources.length > 0) {
            resources[serverName] = report.resources
          }
          return {
            ...prev,
            mcp: {
              ...prev.mcp,
              clients,
              tools,
              commands,
              resources,
            },
          }
        })
      }
      logMCPDebug(serverName, `re-authenticated and reconnected (${report.tools.length} tools)`)
    } catch (error) {
      logMCPError(serverName, error)
    }
  }

  return {
    name: buildMcpToolName(serverName, 'authenticate'),
    isMcp: true,
    mcpInfo: { serverName, toolName: 'authenticate' },
    inputSchema: emptyInputSchema,
    maxResultSizeChars: 10_000,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    userFacingName: () => `${serverName} authenticate (MCP)`,
    description: async () => descriptionText,
    prompt: async () => descriptionText,
    checkPermissions: async input => ({ behavior: 'allow', updatedInput: input }),
    renderToolUseMessage: () => `authenticate the ${serverName} MCP server`,
    renderToolUseRejectedMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam: (output, toolUseID) => ({
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }),
    call: async (_input, context: ToolUseContext) => {
      featureReached('tool', 'mcp__<server>__authenticate')
      const configType = config.type ?? 'stdio'
      if (configType === 'claudeai-proxy') {
        return {
          data: {
            status: 'unsupported',
            message: `The ${serverName} server is a hosted connector — ask the user to run /mcp and select ${serverName} to authenticate it from the menu.`,
          },
        }
      }
      if (configType !== 'sse' && configType !== 'http') {
        return {
          data: {
            status: 'unsupported',
            message: `The ${serverName} server uses the ${configType} transport, which does not support OAuth from this tool. Ask the user to run /mcp to manage its authentication.`,
          },
        }
      }
      try {
        const { promise: urlPromise, resolve: resolveUrl } = Promise.withResolvers<string>()
        const flowPromise = performMCPOAuthFlow(
          serverName,
          config,
          url => {
            resolveUrl(url)
          },
          undefined,
          { skipBrowserOpen: true },
        )
        void flowPromise
          .then(() => reconnectAfterAuth(context?.setAppState))
          .catch(error => {
            logMCPError(serverName, error)
          })
        const authUrl = await Promise.race([urlPromise, flowPromise.then(() => null)])
        if (authUrl !== null) {
          return {
            data: {
              status: 'auth_url',
              authUrl,
              message: `Please open this URL in your browser to authorize the ${serverName} MCP server:\n${authUrl}\nOnce authorized, the server's tools will become available automatically.`,
            },
          }
        }
        return {
          data: {
            status: 'auth_url',
            message: `Authentication for ${serverName} completed silently using cached credentials. The server's tools should now be available.`,
          },
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        return {
          data: {
            status: 'error',
            message: `Authentication for ${serverName} failed: ${why}. Ask the user to run /mcp to manage the server's authentication.`,
          },
        }
      }
    },
  }
}
