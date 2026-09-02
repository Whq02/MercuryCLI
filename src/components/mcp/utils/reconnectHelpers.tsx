// The ONE mapper from a post-reconnect client state to the reported outcome,
// shared by the standalone reconnect screen and both server menus so they can
// never disagree. Callers branch on the success flag.

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
      // Still pending, disabled, or missing entirely.
      return {
        success: false,
        message: `Reconnect outcome for ${serverName} is unknown.`,
      }
  }
}
