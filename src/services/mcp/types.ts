/**
 * The MCP configuration schema family, the scope vocabulary, and the
 * connection-state / serialisation types.
 *
 * Schema factories are lazily constructed (built on first call, then cached)
 * so importing this module stays cheap on paths that never validate.
 *
 * The export set of this file is pinned by the ownership contract inventory:
 * every name must be exported and no other name may be.
 */
import type { Client } from './sdk.js'
import type { Implementation, Resource, ServerCapabilities } from './sdk.js'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Scope + transport vocabularies
// ---------------------------------------------------------------------------

/** Lazy singleton helper — build once, on first use. */
function lazy<T>(build: () => T): () => T {
  let cached: T | undefined
  return () => {
    if (cached === undefined) cached = build()
    return cached
  }
}

/**
 * The configuration-scope vocabulary (persisted and compared as these exact
 * strings). `managed` is part of the vocabulary but no path in this slice
 * produces it.
 */
export const ConfigScopeSchema = lazy(() =>
  z.enum(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed']),
)
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>

/**
 * The narrower transport vocabulary exported for CLI/display use. It omits
 * `ws-ide` and `claudeai-proxy`, so it is NOT interchangeable with the entry
 * `type` tokens below — keep the two vocabularies distinct.
 */
export const TransportSchema = lazy(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
export type Transport = z.infer<ReturnType<typeof TransportSchema>>

// ---------------------------------------------------------------------------
// Server entry schemas (the eight transport shapes)
// ---------------------------------------------------------------------------

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
    /** Opt this server into Cross-App Access (SEP-990). */
    xaa: z.boolean().optional(),
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

export const McpSSEIDEServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('sse-ide'),
    url: z.string(),
    ideName: z.string(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)
export type McpSSEIDEServerConfig = z.infer<ReturnType<typeof McpSSEIDEServerConfigSchema>>

export const McpWebSocketIDEServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('ws-ide'),
    url: z.string(),
    ideName: z.string(),
    authToken: z.string().optional(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)
export type McpWebSocketIDEServerConfig = z.infer<
  ReturnType<typeof McpWebSocketIDEServerConfigSchema>
>

export const McpSdkServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
)
export type McpSdkServerConfig = z.infer<ReturnType<typeof McpSdkServerConfigSchema>>

export const McpClaudeAIProxyServerConfigSchema = lazy(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
    toolPermissions: toolPermissionsSchema().optional(),
  }),
)
export type McpClaudeAIProxyServerConfig = z.infer<
  ReturnType<typeof McpClaudeAIProxyServerConfigSchema>
>

/**
 * The server entry union. Deliberately a PLAIN union, not a discriminated
 * one: validation tries every branch, so a rejected entry reports the
 * union's aggregate failure and an entry whose `type` matches nothing fails
 * all eight branches. Unknown members inside an accepted entry are dropped
 * silently rather than rejected.
 */
export const McpServerConfigSchema = lazy(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpSSEIDEServerConfigSchema(),
    McpWebSocketIDEServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)
export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

/**
 * The top-level config document shape: `.mcp.json`, the managed MCP file,
 * and the `mcpServers` sections of the two config stores. Invalid individual
 * entries fail the WHOLE document (the record value schema is part of the
 * document schema); unknown top-level members are dropped silently.
 */
export const McpJsonConfigSchema = lazy(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)
export type McpJsonConfig = z.infer<ReturnType<typeof McpJsonConfigSchema>>

/**
 * A server config plus its resolution scope (the authority it came from) and,
 * for an extension's servers, the owning extension's id (`<name>@<label>`) —
 * so downstream gates need not race the extension load.
 */
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  extensionSource?: string
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

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

/** A protocol resource tagged with the server it came from. */
export type ServerResource = Resource & { server: string }

// ---------------------------------------------------------------------------
// Serialisation (headless/SDK projections)
// ---------------------------------------------------------------------------

export type SerializedTool = {
  name: string
  description: string
  inputJSONSchema?: { type: 'object'; [key: string]: unknown }
  isMcp?: boolean
  /** The original, unnormalised tool name (when it differs). */
  originalToolName?: string
}

export type SerializedClient = {
  name: string
  type: MCPServerConnection['type']
  capabilities?: ServerCapabilities
}

/** Persisted / SDK-projection shape: the member spellings are cross-version
 *  surface (no live reader today). */
export type MCPCliState = {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  /** Normalised server name → original name (when normalisation changed it). */
  normalizedNames?: Record<string, string>
}
