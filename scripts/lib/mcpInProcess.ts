import type { ConnectedMCPServer, ScopedMcpServerConfig } from '../../src/services/mcp/types.ts'

type ConnectMemo = {
  getServerCacheKey: (name: string, config: ScopedMcpServerConfig) => string
  connectToServer: { cache: { set: (key: string, value: unknown) => unknown; delete: (key: string) => unknown } }
}

export function inProcessServerConfig(name: string): ScopedMcpServerConfig {
  return { type: 'stdio', command: process.execPath, args: ['--in-process-fixture', name], scope: 'dynamic' }
}

export function seatInProcessServer(mcp: ConnectMemo, connection: ConnectedMCPServer): () => void {
  const key = mcp.getServerCacheKey(connection.name, connection.config)
  mcp.connectToServer.cache.set(key, Promise.resolve(connection))
  return () => {
    mcp.connectToServer.cache.delete(key)
  }
}
