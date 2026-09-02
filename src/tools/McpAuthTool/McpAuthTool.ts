import { z } from 'zod/v4'

import type { Tool, ToolUseContext } from '../../Tool.js'
import { performMCPOAuthFlow } from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  reconnectMcpServerImpl,
} from '../../services/mcp/client.js'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import {
  excludeCommandsByServer,
  excludeResourcesByServer,
  excludeToolsByServer,
} from '../../services/mcp/utils.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'

/**
 * Factory for the per-server authentication pseudo-tool: surfaced IN PLACE
 * of an unauthenticated MCP server's real tools, so the model knows the
 * server exists and can start authorisation on the user's behalf. The
 * prefix-based replacement after a successful reconnect is what removes it.
 */

export type McpAuthOutput = {
  message: string
  authUrl?: string
  /** Contract data: the three permitted values. */
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
  const description =
    `The MCP server "${serverName}" (${transportDescription(config)}) is installed but requires authentication before its tools can be used. ` +
    `Calling this tool starts the OAuth flow and returns an authorization URL to share with the user. ` +
    `Once the user authorizes in their browser, the server's real tools become available automatically.`

  /** After the flow settles: refresh auth state, reconnect, and swap the
   *  placeholder out of the app state. Never surfaces as a tool failure. */
  const reconnectContinuation = async (
    setAppState: ToolUseContext['setAppState'] | undefined,
  ): Promise<void> => {
    try {
      clearMcpAuthCache()
      const report = await reconnectMcpServerImpl(serverName, config)
      if (setAppState) {
        setAppState(prev => {
          let clients = prev.mcp.clients
          const existingIndex = clients.findIndex(client => client.name === serverName)
          if (existingIndex === -1) {
            clients = [...clients, report.client]
          } else {
            clients = [...clients]
            clients[existingIndex] = report.client
          }
          // The real tools and commands replace the placeholders BY MCP NAME
          // PREFIX — exactly why this pseudo-tool removes itself.
          const tools = [
            ...excludeToolsByServer(prev.mcp.tools, serverName),
            ...report.tools,
          ]
          const commands = [
            ...excludeCommandsByServer(prev.mcp.commands, serverName),
            ...report.commands,
          ]
          let resources = prev.mcp.resources
          if (report.resources && report.resources.length > 0) {
            resources = { ...resources, [serverName]: report.resources }
          }
          return {
            ...prev,
            mcp: { ...prev.mcp, clients, tools, commands, resources },
          }
        })
      }
      logMCPDebug(
        serverName,
        `re-authenticated and reconnected (${report.tools.length} tools)`,
      )
    } catch (err) {
      logMCPError(serverName, err)
    }
  }

  // Assembled as a plain object, deliberately not through the tool builder.
  const tool = {
    name: buildMcpToolName(serverName, 'authenticate'),
    isMcp: true as const,
    mcpInfo: { serverName, toolName: 'authenticate' },
    inputSchema: emptyInputSchema,
    maxResultSizeChars: 10_000,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} authenticate (MCP)`,
    async description(): Promise<string> {
      return description
    },
    async prompt(): Promise<string> {
      return description
    },
    async checkPermissions(input: Record<string, never>) {
      return { behavior: 'allow' as const, updatedInput: input }
    },
    renderToolUseMessage(): string {
      return `authenticate the ${serverName} MCP server`
    },
    renderToolUseRejectedMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    async call(_input: Record<string, never>, context: ToolUseContext) {
      const configType = config.type ?? 'stdio'
      // Hosted-connector servers authenticate from the interactive menu.
      if (configType === 'claudeai-proxy') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `The ${serverName} server is a hosted connector — ask the user to run /mcp and select ${serverName} to authenticate it from the menu.`,
          } satisfies McpAuthOutput,
        }
      }
      // Only the HTTP-based transports carry an OAuth flow this tool can
      // start (needs-auth originates from an HTTP 401; this is defensive).
      if (configType !== 'sse' && configType !== 'http') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `The ${serverName} server uses the ${configType} transport, which does not support OAuth from this tool. Ask the user to run /mcp to manage its authentication.`,
          } satisfies McpAuthOutput,
        }
      }
      try {
        let resolveUrl: (url: string) => void = () => {}
        const urlPromise = new Promise<string>(resolve => {
          resolveUrl = resolve
        })
        const flowPromise = performMCPOAuthFlow(
          serverName,
          config,
          url => resolveUrl(url),
          undefined,
          { skipBrowserOpen: true },
        )
        // The background continuation is deliberately not awaited by the
        // call: on completion it clears the auth cache, reconnects, and
        // swaps the placeholder tools for the real ones.
        void flowPromise
          .then(() => reconnectContinuation(context.setAppState))
          .catch(err => logMCPError(serverName, err))

        const winner = await Promise.race([
          urlPromise,
          flowPromise.then(() => null),
        ])
        if (winner !== null) {
          return {
            data: {
              status: 'auth_url' as const,
              authUrl: winner,
              message: `Please open this URL in your browser to authorize the ${serverName} MCP server:\n${winner}\nOnce authorized, the server's tools will become available automatically.`,
            } satisfies McpAuthOutput,
          }
        }
        // Cached credentials completed the flow without ever producing a URL.
        return {
          data: {
            status: 'auth_url' as const,
            message: `Authentication for ${serverName} completed silently using cached credentials. The server's tools should now be available.`,
          } satisfies McpAuthOutput,
        }
      } catch (err) {
        return {
          data: {
            status: 'error' as const,
            message: `Authentication for ${serverName} failed: ${err instanceof Error ? err.message : String(err)}. Ask the user to run /mcp to manage the server's authentication.`,
          } satisfies McpAuthOutput,
        }
      }
    },
    mapToolResultToToolResultBlockParam(data: McpAuthOutput, toolUseID: string) {
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content: data.message }
    },
  }
  return tool as Tool<typeof emptyInputSchema, McpAuthOutput>
}
