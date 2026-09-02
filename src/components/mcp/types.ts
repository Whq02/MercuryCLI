// UI-level view models for the `/mcp` settings panel and its sub-views.
//
// These wrap the lower-level connection + config types from
// `../../services/mcp/types.js` into the shapes the React panels consume:
//   - `ServerInfo` is a discriminated union (over `transport`) describing one
//     configured-and-connected MCP server, pairing its live connection
//     (`client`) and parsed config with display metadata (name/scope).
//   - `AgentMcpServerInfo` describes an agent-scoped inline MCP server (declared
//     on an AgentDefinition's `mcpServers`), grouped by name across the agents
//     that reference it.
//   - `MCPViewState` is the panel's view-state machine.
//
// Grounded in the producers/consumers under `src/components/mcp/*`,
// the extensions board, and `src/services/mcp/utils.ts`.
import type {
  ConfigScope,
  MCPServerConnection,
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'

// ---------------------------------------------------------------------------
// ServerInfo — per-transport view model for a configured MCP server.
//
// Common base across every transport variant: the display name, the live
// connection (`client`, an MCPServerConnection carrying `.type`/`.config`), and
// the config scope it was loaded from.
// ---------------------------------------------------------------------------

type ServerInfoBase = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
}

/** A local subprocess (stdio) MCP server. No remote auth, so no `isAuthenticated`. */
export type StdioServerInfo = ServerInfoBase & {
  transport: 'stdio'
  config: McpStdioServerConfig
}

/** A remote SSE MCP server. OAuth-capable, so it carries auth state. */
export type SSEServerInfo = ServerInfoBase & {
  transport: 'sse'
  isAuthenticated: boolean | undefined
  config: McpSSEServerConfig
}

/** A remote streamable-HTTP MCP server. OAuth-capable, so it carries auth state. */
export type HTTPServerInfo = ServerInfoBase & {
  transport: 'http'
  isAuthenticated: boolean | undefined
  config: McpHTTPServerConfig
}

/** A Claude.ai proxy MCP server (the `claudeai-proxy` transport). */
export type ClaudeAIServerInfo = ServerInfoBase & {
  transport: 'claudeai-proxy'
  isAuthenticated: boolean | undefined
  config: McpClaudeAIProxyServerConfig
}

/**
 * One configured-and-connected MCP server as the `/mcp` panel sees it.
 * Discriminated on `transport`; `viewState.server.transport === 'stdio'`
 * narrows to a `StdioServerInfo` (the remote variants share `isAuthenticated`,
 * `config.url`, and OAuth handling).
 */
export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo

// ---------------------------------------------------------------------------
// AgentMcpServerInfo — an inline MCP server declared on an agent definition,
// grouped by server name across the agents that reference it.
//
// Built by `extractAgentMcpServers()`; the agent-server menu reads `url`,
// `command`, and `isAuthenticated` generically across the union (without
// narrowing on `transport`), so each variant declares the off-transport fields
// as optional. Only stdio/sse/http/ws transports are surfaced for agent MCPs.
// ---------------------------------------------------------------------------

type AgentMcpServerInfoBase = {
  name: string
  /** Agent types (agentType) that declare this server, deduped. */
  sourceAgents: string[]
  /** True for OAuth-capable remote transports (sse/http). */
  needsAuth: boolean
  /** Remote-server URL (sse/http/ws). Absent for stdio. */
  url?: string
  /** Subprocess command (stdio). Absent for remote transports. */
  command?: string
  /** Current OAuth state, when known. Populated lazily by the agent menu. */
  isAuthenticated?: boolean
}

export type AgentMcpServerInfo =
  | (AgentMcpServerInfoBase & { transport: 'stdio'; command?: string })
  | (AgentMcpServerInfoBase & { transport: 'sse'; url?: string })
  | (AgentMcpServerInfoBase & { transport: 'http'; url?: string })
  | (AgentMcpServerInfoBase & { transport: 'ws'; url?: string })

// ---------------------------------------------------------------------------
// MCPViewState — the `/mcp` panel's view-state machine (MCPSettings.tsx).
// ---------------------------------------------------------------------------

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
