import * as React from 'react'

import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed, subscribeDynamicMcpConfig } from './dynamicMcpSeed.js'
import type { ScopedMcpServerConfig } from './types.js'
import { useManageMCPConnections } from './useManageMCPConnections.js'

/**
 * React context exposing `reconnect` / `toggle-enabled` for MCP servers to
 * the UI tree. Written as an ordinary component (the snapshot's compiler
 * output is not reproduced). The context value is rebuilt on every render —
 * consumers get a fresh object identity each time the parent renders;
 * memoising it would be a (benign) behaviour change and is deliberately not
 * done here.
 */

type Connections = ReturnType<typeof useManageMCPConnections>

const MCPConnectionContext = React.createContext<Connections | null>(null)

export function MCPConnectionManager({
  children,
  dynamicMcpConfig,
  isStrictMcpConfig,
}: {
  children: React.ReactNode
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  isStrictMcpConfig?: boolean
}): React.ReactNode {
  // The strict flag MUST reach the hook: without it the registry discovered
  // and connected every user/project/extension server under --strict-mcp-config.
  const connections = useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig)
  const value: Connections = {
    reconnectMcpServer: connections.reconnectMcpServer,
    toggleMcpServer: connections.toggleMcpServer,
  }
  return <MCPConnectionContext.Provider value={value}>{children}</MCPConnectionContext.Provider>
}

/** The launch-tree mount: the manager fed LIVE from the one mutable config
 *  owner (dynamicMcpSeed) — the /ide command and the IDE session mount
 *  change the config and the registry re-resolves. */
export function SeededMCPConnectionManager({ children }: { children: React.ReactNode }): React.ReactNode {
  const config = React.useSyncExternalStore(subscribeDynamicMcpConfig, dynamicMcpConfigSnapshot, dynamicMcpConfigSnapshot)
  return (
    <MCPConnectionManager dynamicMcpConfig={config} isStrictMcpConfig={isStrictMcpConfigSeed()}>
      {children}
    </MCPConnectionManager>
  )
}

export function useMcpReconnect(): Connections['reconnectMcpServer'] {
  const context = React.useContext(MCPConnectionContext)
  if (context === null) throw new Error('useMcpReconnect must be used within an MCPConnectionManager')
  return context.reconnectMcpServer
}

export function useMcpToggleEnabled(): Connections['toggleMcpServer'] {
  const context = React.useContext(MCPConnectionContext)
  if (context === null) throw new Error('useMcpToggleEnabled must be used within an MCPConnectionManager')
  return context.toggleMcpServer
}
