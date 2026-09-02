// The /mcp server list: every known client (connected, pending, needs-auth,
// failed, disabled) grouped by config scope, then claude.ai proxies, then
// agent-declared servers, then built-in (dynamic) servers. A disabled or
// failed server stays reachable — the menu is how it gets re-enabled.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import {
  describeMcpConfigFilePath,
  getScopeLabel,
} from '../../services/mcp/utils.js'
import { isDebugMode } from '../../utils/debug.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { McpParsingWarnings, type McpConfigFinding } from './McpParsingWarnings.js'
import type { AgentMcpServerInfo, ServerInfo } from './types.js'

function statusWord(server: ServerInfo): string {
  const client = server.client
  if (client.type === 'pending' && client.reconnectAttempt !== undefined) {
    return `reconnecting ${client.reconnectAttempt}/${
      client.maxReconnectAttempts ?? '?'
    }`
  }
  if (client.type === 'pending') return 'connecting'
  return client.type
}

function statusGlyph(server: ServerInfo): { glyph: string; color?: string } {
  switch (server.client.type) {
    case 'connected':
      return { glyph: GLYPH.done, color: 'success' }
    case 'pending':
      return { glyph: GLYPH.idle }
    case 'needs-auth':
      return { glyph: GLYPH.warn, color: 'warning' }
    case 'failed':
      return { glyph: GLYPH.warn, color: 'error' }
    case 'disabled':
      return { glyph: GLYPH.dot }
  }
}

type RowValue =
  | { kind: 'server'; server: ServerInfo }
  | { kind: 'agent'; agentServer: AgentMcpServerInfo }

export function MCPListPanel({
  servers,
  agentServers,
  errors,
  defaultTab,
  onOpenServer,
  onOpenAgentServer,
  onClose,
}: {
  servers: ServerInfo[]
  agentServers: AgentMcpServerInfo[]
  errors: McpConfigFinding[]
  /** Accepted and ignored — the return-from-menu tab hint (Q2). */
  defaultTab?: string
  onOpenServer: (server: ServerInfo) => void
  onOpenAgentServer: (agentServer: AgentMcpServerInfo) => void
  onClose: () => void
}): React.ReactNode {
  void defaultTab

  const total = servers.length + agentServers.length
  if (total === 0) return null

  // Grouping and order (contract data): the MCP config scopes, then the
  // claude.ai proxies, then agent servers, then built-in (dynamic) last.
  const proxies = servers.filter(server => server.transport === 'claudeai-proxy')
  const grouped: Array<{ heading: string; note?: string; rows: RowValue[] }> = []
  for (const scope of ['project', 'local', 'user', 'enterprise'] as const) {
    const inScope = servers
      .filter(
        server =>
          server.scope === scope && server.transport !== 'claudeai-proxy',
      )
      .sort((a, b) => a.name.localeCompare(b.name))
    if (inScope.length === 0) continue
    grouped.push({
      heading: getScopeLabel(scope),
      // The enterprise group deliberately shows no path.
      note:
        scope === 'enterprise' ? undefined : describeMcpConfigFilePath(scope),
      rows: inScope.map(server => ({ kind: 'server', server })),
    })
  }
  if (proxies.length > 0) {
    grouped.push({
      heading: 'claude.ai',
      rows: [...proxies]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(server => ({ kind: 'server', server })),
    })
  }
  if (agentServers.length > 0) {
    const byAgent = new Map<string, AgentMcpServerInfo[]>()
    for (const agentServer of agentServers) {
      for (const agent of agentServer.sourceAgents) {
        const bucket = byAgent.get(agent) ?? []
        bucket.push(agentServer)
        byAgent.set(agent, bucket)
      }
    }
    for (const [agent, list] of [...byAgent.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      grouped.push({
        heading: `agent: ${agent}`,
        rows: list.map(agentServer => ({ kind: 'agent', agentServer })),
      })
    }
  }
  const dynamic = servers
    .filter(
      server =>
        server.scope === 'dynamic' && server.transport !== 'claudeai-proxy',
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  if (dynamic.length > 0) {
    grouped.push({
      heading: getScopeLabel('dynamic'),
      note: 'always available',
      rows: dynamic.map(server => ({ kind: 'server', server })),
    })
  }

  const anyFailed = servers.some(server => server.client.type === 'failed')
  const options = grouped.flatMap((group, groupIndex) => [
    {
      label: (
        <Text dimColor>
          {group.heading}
          {group.note ? ` (${group.note})` : ''}
        </Text>
      ),
      value: `heading:${groupIndex}`,
      disabled: true,
    },
    ...group.rows.map(row => {
      if (row.kind === 'server') {
        const { glyph, color } = statusGlyph(row.server)
        return {
          label: (
            <Text>
              {row.server.name} <Text color={color}>{glyph}</Text>{' '}
              <Text dimColor>{statusWord(row.server)}</Text>
            </Text>
          ),
          value: `server:${row.server.name}`,
        }
      }
      return {
        label: (
          <Text>
            {row.agentServer.name}{' '}
            <Text dimColor>
              {row.agentServer.needsAuth
                ? 'may need authentication'
                : 'agent-only'}
            </Text>
          </Text>
        ),
        value: `agent:${row.agentServer.name}`,
      }
    }),
  ])

  return (
    <Box flexDirection="column">
      <McpParsingWarnings errors={errors} />
      <Dialog
        title="MCP servers"
        subtitle={`${total} ${plural(total, 'server')}`}
        onCancel={onClose}
        hideInputGuide
      >
        <Select
          options={options}
          hideIndexes
          onChange={value => {
            if (value.startsWith('server:')) {
              const server = servers.find(
                candidate => `server:${candidate.name}` === value,
              )
              if (server) onOpenServer(server)
            } else if (value.startsWith('agent:')) {
              const agentServer = agentServers.find(
                candidate => `agent:${candidate.name}` === value,
              )
              if (agentServer) onOpenAgentServer(agentServer)
            }
          }}
          onCancel={onClose}
        />
        {anyFailed ? (
          <Text dimColor>
            {isDebugMode()
              ? 'A server failed — its error output is in the debug log.'
              : 'A server failed — restart with --debug to capture its error log.'}
          </Text>
        ) : null}
        <Text dimColor>↑↓ navigate · ↵ open · esc close</Text>
      </Dialog>
    </Box>
  )
}
