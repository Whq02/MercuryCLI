
import type { MCPServerConnection } from '../services/mcp/types.js'

export type IdeStatus = 'connected' | 'pending' | 'disconnected' | null

export function useIdeConnectionStatus(mcpClients?: MCPServerConnection[]): {
  status: IdeStatus
  ideName: string | null
} {
  const entry = mcpClients?.find(client => client.name === 'ide')
  if (!entry) return { status: null, ideName: null }
  const status: IdeStatus =
    entry.type === 'connected'
      ? 'connected'
      : entry.type === 'pending'
        ? 'pending'
        : 'disconnected'
  const config = entry.config as { type?: string; ideName?: string }
  const ideName =
    (config.type === 'sse-ide' || config.type === 'ws-ide') && config.ideName
      ? config.ideName
      : null
  return { status, ideName }
}
