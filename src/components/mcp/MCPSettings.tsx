
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MercuryMcpAuthProvider } from '../../services/mcp/auth.js'
import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import {
  extractAgentMcpServers,
  filterToolsByServer,
} from '../../services/mcp/utils.js'
import { useAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { CommandCenter } from '../mercury-ui/components.js'
import { MCPAgentServerMenu } from './MCPAgentServerMenu.js'
import { MCPListPanel } from './MCPListPanel.js'
import type { McpConfigFinding } from './McpParsingWarnings.js'
import { MCPRemoteServerMenu } from './MCPRemoteServerMenu.js'
import { MCPStdioServerMenu } from './MCPStdioServerMenu.js'
import { MCPToolDetailView } from './MCPToolDetailView.js'
import { MCPToolListView } from './MCPToolListView.js'
import type { Tool } from '../../Tool.js'
import type { MCPViewState, ServerInfo } from './types.js'

const IDE_CLIENT_NAME = 'ide'

const AUTH_PROBE_TIMEOUT_MS = 3_000

async function probeAuthentication(
  client: MCPServerConnection,
  hasTools: boolean,
): Promise<boolean | undefined> {
  try {
    const probe = new MercuryMcpAuthProvider(client.name, client.config)
      .tokens()
      .then(tokens => tokens !== undefined)
    const timeout = new Promise<undefined>(resolve =>
      setTimeout(() => resolve(undefined), AUTH_PROBE_TIMEOUT_MS),
    )
    const hasTokens = await Promise.race([probe, timeout])
    if (hasTokens === true) return true
    if (client.type === 'connected' && hasTools) return true
    return hasTokens
  } catch {
    return undefined
  }
}

export function MCPSettings({
  onComplete,
}: {
  onComplete: LocalJSXCommandOnDone
}): React.ReactNode {
  const clients = useAppState(state => state.mcp.clients)
  const allTools = useAppState(state => state.mcp.tools)
  const activeAgents = useAppState(
    state => state.agentDefinitions.activeAgents,
  )
  const [view, setView] = useState<MCPViewState>({ type: 'list' })
  const [servers, setServers] = useState<ServerInfo[] | null>(null)

  const agentServers = useMemo(
    () => extractAgentMcpServers(activeAgents),
    [activeAgents],
  )

  const configErrors = useMemo<McpConfigFinding[]>(
    () =>
      (['user', 'project', 'local', 'enterprise'] as const).flatMap(
        scope => getMcpConfigsByScope(scope).errors,
      ),
    [],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const eligible = [...clients]
        .filter(client => client.name !== IDE_CLIENT_NAME)
        .sort((a, b) => a.name.localeCompare(b.name))
      const prepared = await Promise.all(
        eligible.map(async (client): Promise<ServerInfo> => {
          const config = client.config
          const scope = config.scope
          const hasTools =
            filterToolsByServer(allTools, client.name).length > 0
          switch (config.type) {
            case 'sse':
              return {
                name: client.name,
                client,
                scope,
                transport: 'sse',
                isAuthenticated: await probeAuthentication(client, hasTools),
                config,
              }
            case 'http':
              return {
                name: client.name,
                client,
                scope,
                transport: 'http',
                isAuthenticated: await probeAuthentication(client, hasTools),
                config,
              }
            case 'claudeai-proxy':
              return {
                name: client.name,
                client,
                scope,
                transport: 'claudeai-proxy',
                isAuthenticated: false,
                config,
              }
            default:
              return {
                name: client.name,
                client,
                scope,
                transport: 'stdio',
                config,
              } as ServerInfo
          }
        }),
      )
      if (!cancelled) setServers(prepared)
    })()
    return () => {
      cancelled = true
    }
  }, [clients, allTools])

  const close = () => onComplete('MCP settings closed', { display: 'system' })

  const completedRef = useRef(false)
  const isEmpty =
    servers !== null && servers.length === 0 && agentServers.length === 0
  useEffect(() => {
    if (!isEmpty || completedRef.current) return
    completedRef.current = true
    onComplete(
      'No MCP servers are configured. Add them in .mcp.json or settings.json, and run the health command (/health) if a configured server is missing here.',
    )
  }, [isEmpty, onComplete])
  if (isEmpty) return null

  const effectiveView: MCPViewState =
    view.type === 'server-tool-detail' &&
    filterToolsByServer(allTools, view.server.name).length <= view.toolIndex
      ? { type: 'server-tools', server: view.server }
      : view

  return (
    <CommandCenter
      view="mcp"
      subtitle="this screen's servers — sessions carry their own; the boot menu sets the next session's"
      onClose={close}
      captureInput={false}
      closeKeys="esc"
      footer="↑↓ select · ↵ open"
    >
      {effectiveView.type === 'list' ? (
        servers === null ? null : (
          <MCPListPanel
            servers={servers}
            agentServers={agentServers}
            errors={configErrors}
            onOpenServer={server => setView({ type: 'server-menu', server })}
            onOpenAgentServer={agentServer =>
              setView({ type: 'agent-server-menu', agentServer })
            }
            onClose={close}
          />
        )
      ) : effectiveView.type === 'server-menu' ? (
        effectiveView.server.transport === 'stdio' ? (
          <MCPStdioServerMenu
            server={effectiveView.server}
            serverToolsCount={
              filterToolsByServer(allTools, effectiveView.server.name).length
            }
            onViewTools={() =>
              setView({ type: 'server-tools', server: effectiveView.server })
            }
            onCancel={tab => setView({ type: 'list', defaultTab: tab })}
            onComplete={() => setView({ type: 'list' })}
          />
        ) : (
          <MCPRemoteServerMenu
            server={effectiveView.server}
            serverToolsCount={
              filterToolsByServer(allTools, effectiveView.server.name).length
            }
            onViewTools={() =>
              setView({ type: 'server-tools', server: effectiveView.server })
            }
            onCancel={tab => setView({ type: 'list', defaultTab: tab })}
            onComplete={() => setView({ type: 'list' })}
          />
        )
      ) : effectiveView.type === 'server-tools' ? (
        <MCPToolListView
          server={effectiveView.server}
          onSelectTool={(tool: Tool) => {
            const toolIndex = filterToolsByServer(
              allTools,
              effectiveView.server.name,
            ).indexOf(tool)
            if (toolIndex !== -1) {
              setView({
                type: 'server-tool-detail',
                server: effectiveView.server,
                toolIndex,
              })
            }
          }}
          onBack={() =>
            setView({ type: 'server-menu', server: effectiveView.server })
          }
        />
      ) : effectiveView.type === 'server-tool-detail' ? (
        (() => {
          const tool = filterToolsByServer(
            allTools,
            effectiveView.server.name,
          )[effectiveView.toolIndex]
          return tool ? (
            <MCPToolDetailView
              tool={tool}
              server={effectiveView.server}
              onBack={() =>
                setView({ type: 'server-tools', server: effectiveView.server })
              }
            />
          ) : null
        })()
      ) : (
        <MCPAgentServerMenu
          agentServer={effectiveView.agentServer}
          onBack={() => setView({ type: 'list', defaultTab: 'agents' })}
        />
      )}
    </CommandCenter>
  )
}
