import type { Client, Implementation, Resource, ServerCapabilities, Tool } from './sdk.js'
import { z } from 'zod'
import { passedOver } from '../passedOver.js'

export type McpBootstrapManifest = {
  serverInfo: Implementation
  capabilities: ServerCapabilities
  instructions: string
  tools: Tool[]
}

function once<T>(build: () => T): () => T {
  const held: T[] = []
  return () => {
    if (!held.length) held.push(build())
    return held[0]!
  }
}

export const ConfigScopeSchema = once(() =>
  z.enum(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed']),
)
export const TransportSchema = once(() => z.enum(['stdio', 'sse', 'http', 'ws']))
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>
export type Transport = z.infer<ReturnType<typeof TransportSchema>>

function secureMetadataUrl(value: string | undefined): boolean {
  if (value === undefined) return true
  try {
    new URL(value)
    return value.startsWith('https://')
  } catch (error) {
    passedOver(error)
    return false
  }
}

const strings = () => z.record(z.string(), z.string())
const isStringRecord = (value: unknown): value is Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every(item => typeof item === 'string')
const everyKeyKept = (value: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true })
  return out
}
export const McpServerConfigSchema = once(() => {
  const toolPermissions = z
    .custom<Record<string, string>>(isStringRecord, 'expected tool names mapped to permission words')
    .transform(everyKeyKept)
  const oauth = z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z
      .string()
      .optional()
      .refine(secureMetadataUrl, { message: 'authServerMetadataUrl must be a valid https:// URL' }),
  })
  const stdio = z.object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).default([]),
    env: strings().optional(),
  })
  const sse = z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: strings().optional(),
    headersHelper: z.string().optional(),
    oauth: oauth.optional(),
    toolPermissions: toolPermissions.optional(),
  })
  const http = z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: strings().optional(),
    headersHelper: z.string().optional(),
    oauth: oauth.optional(),
    toolPermissions: toolPermissions.optional(),
  })
  const ws = z.object({
    type: z.literal('ws'),
    url: z.string(),
    headers: strings().optional(),
    headersHelper: z.string().optional(),
  })
  const proxy = z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
    toolPermissions: toolPermissions.optional(),
  })
  return z.union([stdio, sse, http, ws, proxy])
})
export const McpJsonConfigSchema = once(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)

export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

export type McpUnexpandedStrings = {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  extensionSource?: string
  unexpanded?: McpUnexpandedStrings
  bundledBootstrap?: McpBootstrapManifest
  inlineDispatchId?: string
}

type ServerIdentity = {
  name: string
  config: ScopedMcpServerConfig
}
type ConnectionFacts = {
  connected: {
    client: Client
    capabilities: ServerCapabilities
    cleanup: () => Promise<void>
    serverInfo?: Implementation
    instructions?: string
  }
  failed: {
    error?: string
  }
  pending: {
    reconnectAttempt?: number
    maxReconnectAttempts?: number
  }
  disabled: Record<never, never>
  'needs-auth': Record<never, never>
}
type Connection<State extends keyof ConnectionFacts> = ServerIdentity & { type: State } & ConnectionFacts[State]
export type ConnectedMCPServer = Connection<'connected'>
export type MCPServerConnection =
  | Connection<'connected'>
  | Connection<'failed'>
  | Connection<'pending'>
  | Connection<'disabled'>
  | Connection<'needs-auth'>
export type ServerResource = Resource & { server: string }
