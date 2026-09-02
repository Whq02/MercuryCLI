import type {
  ConfigScope,
  MCPServerConnection,
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'


type ServerInfoBase = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
}

export type StdioServerInfo = ServerInfoBase & {
  transport: 'stdio'
  config: McpStdioServerConfig
}

export type SSEServerInfo = ServerInfoBase & {
  transport: 'sse'
  isAuthenticated: boolean | undefined
  config: McpSSEServerConfig
}

export type HTTPServerInfo = ServerInfoBase & {
  transport: 'http'
  isAuthenticated: boolean | undefined
  config: McpHTTPServerConfig
}

export type ClaudeAIServerInfo = ServerInfoBase & {
  transport: 'claudeai-proxy'
  isAuthenticated: boolean | undefined
  config: McpClaudeAIProxyServerConfig
}

export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo


type AgentMcpServerInfoBase = {
  name: string
  sourceAgents: string[]
  needsAuth: boolean
  url?: string
  command?: string
  isAuthenticated?: boolean
}

export type AgentMcpServerInfo =
  | (AgentMcpServerInfoBase & { transport: 'stdio'; command?: string })
  | (AgentMcpServerInfoBase & { transport: 'sse'; url?: string })
  | (AgentMcpServerInfoBase & { transport: 'http'; url?: string })
  | (AgentMcpServerInfoBase & { transport: 'ws'; url?: string })


export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
