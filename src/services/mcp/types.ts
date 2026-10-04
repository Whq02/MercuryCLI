import type { Client } from './sdk.js'
import type { Implementation, Resource, ServerCapabilities } from './sdk.js'
import { z } from 'zod'


function lazy<T>(build: () => T): () => T {
  let cached: T | undefined
  return () => {
    if (cached === undefined) cached = build()
    return cached
  }
}

export const ConfigScopeSchema = lazy(() =>
  z.enum(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed']),
)
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>

export const TransportSchema = lazy(() =>
  z.enum(['stdio', 'sse', 'http', 'ws']),
)
export type Transport = z.infer<ReturnType<typeof TransportSchema>>


const oauthConfigSchema = lazy(() =>
  z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z
      .string()
      .optional()
      .refine(
        value => {
          if (value === undefined) return true
          try {
            new URL(value)
          } catch {
            return false
          }
          return value.startsWith('https://')
        },
        { message: 'authServerMetadataUrl must be a valid https:// URL' },
      ),
  }),
)

const toolPermissionsSchema = lazy(() => z.record(z.string(), z.string()))

export const McpStdioServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
)
export type McpStdioServerConfig = z.infer<ReturnType<typeof McpStdioServerConfigSchema>>

export const McpSSEServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: oauthConfigSchema().optional(),
    toolPermissions: toolPermissionsSchema().optional(),
  }),
)
export type McpSSEServerConfig = z.infer<ReturnType<typeof McpSSEServerConfigSchema>>

export const McpHTTPServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: oauthConfigSchema().optional(),
    toolPermissions: toolPermissionsSchema().optional(),
  }),
)
export type McpHTTPServerConfig = z.infer<ReturnType<typeof McpHTTPServerConfigSchema>>

export const McpWebSocketServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('ws'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
  }),
)
export type McpWebSocketServerConfig = z.infer<ReturnType<typeof McpWebSocketServerConfigSchema>>

export const McpAnthropicProxyServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
    toolPermissions: toolPermissionsSchema().optional(),
  }),
)
export type McpAnthropicProxyServerConfig = z.infer<
  ReturnType<typeof McpAnthropicProxyServerConfigSchema>
>

export const McpServerConfigSchema = lazy(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpAnthropicProxyServerConfigSchema(),
  ]),
)
export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

export const McpJsonConfigSchema = lazy(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)
export type McpJsonConfig = z.infer<ReturnType<typeof McpJsonConfigSchema>>

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  extensionSource?: string
}


export type ConnectedMCPServer = {
  type: 'connected'
  name: string
  client: Client
  capabilities: ServerCapabilities
  serverInfo?: Implementation
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

export type FailedMCPServer = {
  type: 'failed'
  name: string
  config: ScopedMcpServerConfig
  error?: string
}

export type NeedsAuthMCPServer = {
  type: 'needs-auth'
  name: string
  config: ScopedMcpServerConfig
}

export type PendingMCPServer = {
  type: 'pending'
  name: string
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

export type DisabledMCPServer = {
  type: 'disabled'
  name: string
  config: ScopedMcpServerConfig
}

export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer

export type ServerResource = Resource & { server: string }


export type SerializedTool = {
  name: string
  description: string
  inputJSONSchema?: { type: 'object'; [key: string]: unknown }
  isMcp?: boolean
  originalToolName?: string
}

export type SerializedClient = {
  name: string
  type: MCPServerConnection['type']
  capabilities?: ServerCapabilities
}

export type MCPCliState = {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  normalizedNames?: Record<string, string>
}
