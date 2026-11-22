import type { Client, Implementation, Resource, ServerCapabilities, Tool } from './sdk.js'
import { z } from 'zod'
import { passedOver } from '../passedOver.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

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

export const ConfigScopeSchema: Unbuilt = unbuilt('src/utils/mcp/types.ts:20')
export const TransportSchema: Unbuilt = unbuilt('src/utils/mcp/types.ts:21')
export type ConfigScope = Unbuilt
export type Transport = Unbuilt

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
export const McpServerConfigSchema: Unbuilt = unbuilt('src/utils/mcp/types.ts:61')
export const McpJsonConfigSchema: Unbuilt = unbuilt('src/utils/mcp/types.ts:65')

export type McpServerConfig = Unbuilt
export type McpUnexpandedStrings = Unbuilt
export type ScopedMcpServerConfig = Unbuilt

type ServerIdentity = Unbuilt
type ConnectionFacts = Unbuilt
type Connection<State extends keyof ConnectionFacts> = ServerIdentity & { type: State } & ConnectionFacts[State]
export type ConnectedMCPServer = Connection<'connected'>
export type MCPServerConnection = { [State in keyof ConnectionFacts]: Connection<State> }[keyof ConnectionFacts]
export type ServerResource = Resource & { server: string }
