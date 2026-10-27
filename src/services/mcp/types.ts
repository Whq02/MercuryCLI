import type { Client, Implementation, Resource, ServerCapabilities } from './sdk.js'
import { z } from 'zod'

function once<T>(build: () => T): () => T {
  const held: T[] = []
  return () => {
    if (!held.length) held.push(build())
    return held[0]!
  }
}

export const ConfigScopeSchema = once(() => z.enum(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed']))
export const TransportSchema = once(() => z.enum(['stdio', 'sse', 'http', 'ws']))
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>
export type Transport = z.infer<ReturnType<typeof TransportSchema>>

function secureMetadataUrl(value: string | undefined): boolean {
  if (value === undefined) return true
  try {
    new URL(value)
    return value.startsWith('https://')
  } catch {
    return false
  }
}

const strings = () => z.record(z.string(), z.string())
const oauth = once(() => z.object({
  clientId: z.string().optional(),
  callbackPort: z.number().int().positive().optional(),
  authServerMetadataUrl: z.string().optional().refine(secureMetadataUrl, { message: 'authServerMetadataUrl must be a valid https:// URL' }),
}))
const toolPermissions = once(strings)
const remoteFields = () => ({ url: z.string(), headers: strings().optional(), headersHelper: z.string().optional() })
const authenticatedFields = () => ({ oauth: oauth().optional(), toolPermissions: toolPermissions().optional() })

const McpStdioServerConfigSchema = once(() => z.object({
  type: z.literal('stdio').optional(), command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).default([]), env: strings().optional(),
}))
const McpSSEServerConfigSchema = once(() => z.object({ type: z.literal('sse'), ...remoteFields(), ...authenticatedFields() }))
const McpHTTPServerConfigSchema = once(() => z.object({ type: z.literal('http'), ...remoteFields(), ...authenticatedFields() }))
const McpWebSocketServerConfigSchema = once(() => z.object({ type: z.literal('ws'), ...remoteFields() }))
const McpAnthropicProxyServerConfigSchema = once(() => z.object({ type: z.literal('claudeai-proxy'), url: z.string(), id: z.string(), toolPermissions: toolPermissions().optional() }))
export const McpServerConfigSchema = once(() => z.union([
  McpStdioServerConfigSchema(), McpSSEServerConfigSchema(), McpHTTPServerConfigSchema(),
  McpWebSocketServerConfigSchema(), McpAnthropicProxyServerConfigSchema(),
]))
export const McpJsonConfigSchema = once(() => z.object({ mcpServers: z.record(z.string(), McpServerConfigSchema()) }))

export type McpStdioServerConfig = z.infer<ReturnType<typeof McpStdioServerConfigSchema>>
export type McpSSEServerConfig = z.infer<ReturnType<typeof McpSSEServerConfigSchema>>
export type McpHTTPServerConfig = z.infer<ReturnType<typeof McpHTTPServerConfigSchema>>
export type McpAnthropicProxyServerConfig = z.infer<ReturnType<typeof McpAnthropicProxyServerConfigSchema>>
export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>
export type McpUnexpandedStrings = { command?: string; args?: string[]; url?: string }
export type ScopedMcpServerConfig = McpServerConfig & { scope: ConfigScope; extensionSource?: string; unexpanded?: McpUnexpandedStrings }

type ServerIdentity = { name: string; config: ScopedMcpServerConfig }
type ConnectionFacts = {
  connected: { client: Client; capabilities: ServerCapabilities; serverInfo?: Implementation; instructions?: string; cleanup: () => Promise<void> }
  failed: { error?: string }
  'needs-auth': Record<never, never>
  pending: { reconnectAttempt?: number; maxReconnectAttempts?: number }
  disabled: Record<never, never>
}
type Connection<State extends keyof ConnectionFacts> = ServerIdentity & { type: State } & ConnectionFacts[State]
export type ConnectedMCPServer = Connection<'connected'>
export type MCPServerConnection = { [State in keyof ConnectionFacts]: Connection<State> }[keyof ConnectionFacts]
export type ServerResource = Resource & { server: string }
