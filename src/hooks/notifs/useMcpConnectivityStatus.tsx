// Notices for failed / needs-auth MCP servers, split local vs. claude.ai
// connectors. One notification per non-empty bucket; a bucket that empties
// later leaves its last notice to expire on the centre's own terms.

import * as React from 'react'
import { useEffect } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { hasClaudeAiMcpEverConnected } from '../../services/mcp/claudeai.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

const IDE_OR_PROXY_TYPES = ['sse-ide', 'ws-ide', 'claudeai-proxy']

const EMPTY_CLIENTS: MCPServerConnection[] = []

type Props = {
  mcpClients?: MCPServerConnection[]
}

export function useMcpConnectivityStatus({ mcpClients }: Props): void {
  const { addNotification } = useNotifications()
  const clients = mcpClients ?? EMPTY_CLIENTS

  useEffect(() => {
    if (getIsRemoteMode()) return

    const failedLocal = clients.filter(
      client =>
        client.type === 'failed' &&
        !IDE_OR_PROXY_TYPES.includes(client.config.type ?? ''),
    )
    const failedClaudeAi = clients.filter(
      client =>
        client.type === 'failed' &&
        client.config.type === 'claudeai-proxy' &&
        hasClaudeAiMcpEverConnected(client.name),
    )
    const needsAuthLocal = clients.filter(
      client =>
        client.type === 'needs-auth' && client.config.type !== 'claudeai-proxy',
    )
    const needsAuthClaudeAi = clients.filter(
      client =>
        client.type === 'needs-auth' &&
        client.config.type === 'claudeai-proxy' &&
        hasClaudeAiMcpEverConnected(client.name),
    )

    if (
      failedLocal.length === 0 &&
      failedClaudeAi.length === 0 &&
      needsAuthLocal.length === 0 &&
      needsAuthClaudeAi.length === 0
    ) {
      return
    }

    const plural = (n: number): string => (n === 1 ? '' : 's')

    if (failedLocal.length > 0) {
      addNotification({
        key: 'mcp-failed',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text> {failedLocal.length} MCP
            server{plural(failedLocal.length)} failed
            <Text dimColor> — /mcp for details</Text>
          </Text>
        ),
      })
    }
    if (failedClaudeAi.length > 0) {
      addNotification({
        key: 'mcp-claudeai-failed',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text> {failedClaudeAi.length}{' '}
            claude.ai connector{plural(failedClaudeAi.length)} unavailable
            <Text dimColor> — /mcp for details</Text>
          </Text>
        ),
      })
    }
    if (needsAuthLocal.length > 0) {
      addNotification({
        key: 'mcp-needs-auth',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="warning">{GLYPH.warn}</Text> {needsAuthLocal.length}{' '}
            MCP server{plural(needsAuthLocal.length)}{' '}
            {needsAuthLocal.length === 1 ? 'needs' : 'need'} authentication
            <Text dimColor> — /mcp for details</Text>
          </Text>
        ),
      })
    }
    if (needsAuthClaudeAi.length > 0) {
      addNotification({
        key: 'mcp-claudeai-needs-auth',
        priority: 'medium',
        jsx: (
          <Text>
            <Text color="warning">{GLYPH.warn}</Text> {needsAuthClaudeAi.length}{' '}
            claude.ai connector{plural(needsAuthClaudeAi.length)}{' '}
            {needsAuthClaudeAi.length === 1 ? 'needs' : 'need'} authentication
            <Text dimColor> — /mcp for details</Text>
          </Text>
        ),
      })
    }
  }, [clients, addNotification])
}
