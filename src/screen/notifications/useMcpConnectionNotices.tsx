import { usePublish } from '../effects/effects.js'
import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { GLYPH } from '../theme/glyphs.js'
import { useNotifications } from './notifications.js'
import { Text } from '../themedRenderer.js'
import { hasAnthropicConnectorEverConnected } from '../../integrations/mcp/anthropicConnectors.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'

const PROXY_TYPES = ['claudeai-proxy']

const EMPTY_CLIENTS: MCPServerConnection[] = []

type Props = {
  mcpClients?: MCPServerConnection[]
}

export function useMcpConnectionNotices({
  mcpClients = EMPTY_CLIENTS,
}: Props): void {
  const { addNotification } = useNotifications()

  usePublish(() => {
    if (getIsRemoteMode()) return

    let failedCount = 0
    let claudeaiFailedCount = 0
    let needsAuthCount = 0
    let claudeaiNeedsAuthCount = 0

    for (const client of mcpClients) {
      const isProxy =
        client.config.type !== undefined &&
        PROXY_TYPES.includes(client.config.type)
      if (client.type === 'failed') {
        if (isProxy) {
          if (hasAnthropicConnectorEverConnected(client.name)) {
            claudeaiFailedCount++
          }
        } else {
          failedCount++
        }
      } else if (client.type === 'needs-auth') {
        if (isProxy) {
          if (hasAnthropicConnectorEverConnected(client.name)) {
            claudeaiNeedsAuthCount++
          }
        } else {
          needsAuthCount++
        }
      }
    }

    if (failedCount > 0) {
      addNotification({
        key: 'mcp-failed',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text>
            {` ${failedCount} MCP ${failedCount === 1 ? 'server' : 'servers'} failed`}
            <Text dimColor>{' — /mcp for details'}</Text>
          </Text>
        ),
      })
    }

    if (claudeaiFailedCount > 0) {
      addNotification({
        key: 'mcp-claudeai-failed',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text>
            {` ${claudeaiFailedCount} claude.ai connector${claudeaiFailedCount === 1 ? '' : 's'} unavailable`}
            <Text dimColor>{' — /mcp for details'}</Text>
          </Text>
        ),
      })
    }

    if (needsAuthCount > 0) {
      addNotification({
        key: 'mcp-needs-auth',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="warning">{GLYPH.warn}</Text>
            {` ${needsAuthCount} MCP ${needsAuthCount === 1 ? 'server needs' : 'servers need'} authentication`}
            <Text dimColor>{' — /mcp for details'}</Text>
          </Text>
        ),
      })
    }

    if (claudeaiNeedsAuthCount > 0) {
      addNotification({
        key: 'mcp-claudeai-needs-auth',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="warning">{GLYPH.warn}</Text>
            {` ${claudeaiNeedsAuthCount} claude.ai ${claudeaiNeedsAuthCount === 1 ? 'connector needs' : 'connectors need'} authentication`}
            <Text dimColor>{' — /mcp for details'}</Text>
          </Text>
        ),
      })
    }
  }, [mcpClients, addNotification])
}
