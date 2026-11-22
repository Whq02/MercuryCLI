import { usePublish } from '../effects.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { GLYPH } from '../../utils/glyphs.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { hasAnthropicConnectorEverConnected } from '../../services/mcp/anthropicConnectors.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { notBuilt } from '../../pi/holes.js'

const PROXY_TYPES = ['claudeai-proxy']

const EMPTY_CLIENTS: MCPServerConnection[] = []

type Props = {
  mcpClients?: MCPServerConnection[]
}

export function useMcpConnectivityStatus(arg0: Props): void {
  return notBuilt('src/hooks/notifs/useMcpConnectivityStatus.tsx:18')
}
