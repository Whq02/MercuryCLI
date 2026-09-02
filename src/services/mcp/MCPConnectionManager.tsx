import * as React from 'react'

import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed, subscribeDynamicMcpConfig } from './dynamicMcpSeed.js'
import type { ScopedMcpServerConfig } from './types.js'
import { useManageMCPConnections } from './useManageMCPConnections.js'


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
  const connections = useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig)
  const value: Connections = {
    reconnectMcpServer: connections.reconnectMcpServer,
    toggleMcpServer: connections.toggleMcpServer,
  }
  return <MCPConnectionContext.Provider value={value}>{children}</MCPConnectionContext.Provider>
}

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
