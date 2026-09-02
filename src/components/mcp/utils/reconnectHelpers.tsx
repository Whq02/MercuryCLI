
import type { MCPServerConnection } from '../../../services/mcp/types.js'

export type ReconnectOutcome = {
  success: boolean
  message: string
}

export function describeReconnectOutcome(
  serverName: string,
  client: MCPServerConnection | undefined,
): ReconnectOutcome {
  switch (client?.type) {
    case 'connected':
      return { success: true, message: `Reconnected to ${serverName}.` }
    case 'needs-auth':
      return {
        success: false,
        message: `${serverName} needs authentication — open /mcp and use its authenticate option.`,
      }
    case 'failed':
      return {
        success: false,
        message: `Reconnecting to ${serverName} failed.`,
      }
    default:
      return {
        success: false,
        message: `Reconnect outcome for ${serverName} is unknown.`,
      }
  }
}
