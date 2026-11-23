import type { ensureConnectedClient, fetchResourcesForClient, reconnectMcpServerImpl } from '../client.js'

type McpClientForTools = {
  ensureConnectedClient: typeof ensureConnectedClient
  fetchResourcesForClient: typeof fetchResourcesForClient
  reconnectMcpServerImpl: typeof reconnectMcpServerImpl
}

let clientForTools: McpClientForTools | undefined

export function tellMcpToolsTheClient(client: McpClientForTools): void {
  clientForTools = client
}

export function mcpClientForTools(): McpClientForTools {
  return clientForTools!
}
