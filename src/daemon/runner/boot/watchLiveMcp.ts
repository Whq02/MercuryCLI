import type { ScopedMcpServerConfig, MCPServerConnection } from '../../../integrations/mcp-shapes/mcpServerRecords.js'
import { getMcpConfigByName, getMercuryMcpConfigs, filterMcpServersByPolicy } from '../../../integrations/mcp/serverConfigs.js'
import { fetchToolsForClient, fetchCommandsForClient, fetchResourcesForClient, reconnectMcpServerImpl, clearServerCache, supplementaryToolsForMcpClient, pruneStaleMcpResourceTools } from '../../../integrations/mcp/client.js'
import { getMcpPrefix } from '../../../integrations/mcp-shapes/mcpToolNames.js'
import { requestDeliberateToolChange } from '../../../models/roads/lawfulPrefixChange.js'
import { processMainOwner } from '../../../engine/run-owner/resolveOwner.js'
import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed } from '../../../integrations/mcp/dynamicMcpSeed.js'
import { watchLiveMcpConfig } from '../../../integrations/mcp/liveConfig.js'
import { mcpConfigAsWritten } from '../../../integrations/mcp/utils.js'
import { randomUUID } from 'node:crypto'
import { dropMcpServerFromAppState } from '../../../integrations/mcp/kitDial.js'
import { isMcpCatalogueMember } from '../../../integrations/mcp/membership.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

function run(ports: RunnerPorts): BootMade<'resolveServerConfigFromAllSources' | 'applyReconnectedClient' | 'mcpSignIns' | 'permittedMcpConfig' | 'reconnectLiveMcp' | 'liveMcp'> {
  const { asks, elicitationRegistered, getAppState, isConcourseWorker, live, registerCleanup, registerPerTurnHandlers, serializeMcpChange, setAppState } = ports
  const resolveServerConfigFromAllSources = (
    serverName: string,
  ): ScopedMcpServerConfig | null => {
    const configured = getMcpConfigByName(serverName)
    if (configured) return configured
    const fromClients = getAppState().mcp.clients.find(client => client.name === serverName)
    return fromClients?.config ?? null
  }

  const applyReconnectedClient = async (serverName: string, client: MCPServerConnection): Promise<void> => {
    const [tools, commandsForServer, resources] = await Promise.all([
      fetchToolsForClient(client),
      fetchCommandsForClient(client),
      fetchResourcesForClient(client),
    ])
    const allTools = [...tools, ...supplementaryToolsForMcpClient(client)]
    const prefix = getMcpPrefix(serverName)
    if (allTools.length > 0) requestDeliberateToolChange(String(processMainOwner()), allTools, `the MCP server ${serverName} joined or reconnected`)
    setAppState(previous => {
      const nextClients = previous.mcp.clients.some(existing => existing.name === serverName)
        ? previous.mcp.clients.map(existing =>
            existing.name === serverName ? client : existing,
          )
        : [...previous.mcp.clients, client]
      const seenTools = new Set<string>()
      const nextTools = pruneStaleMcpResourceTools(
        nextClients,
        [
          ...previous.mcp.tools.filter(tool => !tool.name.startsWith(prefix)),
          ...allTools,
        ].filter(tool => {
          if (seenTools.has(tool.name)) return false
          seenTools.add(tool.name)
          return true
        }),
      )
      return {
        ...previous,
        mcp: {
          ...previous.mcp,
          clients: nextClients,
          tools: nextTools,
          commands: [
            ...previous.mcp.commands.filter(existing => !existing.name.startsWith(prefix)),
            ...commandsForServer,
          ],
          resources: {
            ...Object.fromEntries(
              Object.entries(previous.mcp.resources ?? {}).filter(([key]) => key !== serverName),
            ),
            ...(resources.length > 0 ? { [serverName]: resources } : {}),
          },
        },
      }
    })
  }

  const mcpSignIns = new Map<string, { controller: AbortController; authorizationUrl?: string }>()
  const permittedMcpConfig = async (name: string): Promise<ScopedMcpServerConfig | null> => {
    const dynamic = dynamicMcpConfigSnapshot() ?? {}
    const resolved = isStrictMcpConfigSeed() ? { servers: {} } : await getMercuryMcpConfigs(dynamic)
    const { allowed } = filterMcpServersByPolicy({ ...resolved.servers, ...dynamic })
    return allowed[name] ?? null
  }
  const reconnectLiveMcp = async (name: string, config: ScopedMcpServerConfig): Promise<MCPServerConnection> => {
    const result = await reconnectMcpServerImpl(name, config)
    await applyReconnectedClient(name, result.client)
    registerPerTurnHandlers([result.client])
    return result.client
  }
  const liveMcp = watchLiveMcpConfig({
    hosted: isConcourseWorker,
    initial: Object.fromEntries(getAppState().mcp.clients.filter(client => ['user', 'local', 'project', 'enterprise'].includes(client.config.scope) || client.config.extensionSource !== undefined).map(client => [client.name, client.config])),
    ready: () => !live.awaitingSessionClaim && live.mcpInitialized,
    approve: async (name, config) => {
      const written = mcpConfigAsWritten(config)
      const target = written.url ?? written.command
      const key = `mcp-project-${randomUUID()}`
      const result = await asks.askPermission({
        kind: 'tool', tool_use_id: key, tool_name: 'MCP', title: `Trust new project MCP server ${name}`,
        input: { server: name, target, scope: 'project' },
        reason: 'MCP servers may execute code or access external systems. Use this project server?',
      }, { key })
      return result.outcome === 'allow' ? 'allow' : result.unanswered === true ? 'unanswered' : 'deny'
    },
    reconcile: (next, previous) => serializeMcpChange(async () => {
      for (const row of getAppState().mcp.clients) {
        const configuredScope = ['user', 'local', 'project', 'enterprise'].includes(row.config.scope) || row.name in previous
        if (!configuredScope || row.name in next) continue
        mcpSignIns.get(row.name)?.controller.abort()
        await clearServerCache(row.name, row.config).catch(passedOver)
        elicitationRegistered.delete(row.name)
        setAppState(state => {
          const pruned = dropMcpServerFromAppState(state, row.name, row.config)
          return { ...pruned, mcp: { ...pruned.mcp, clients: pruned.mcp.clients.filter(client => client.name !== row.name) } }
        })
      }
      for (const [name, config] of Object.entries(next)) {
        if (!isMcpCatalogueMember(name)) continue
        const row = getAppState().mcp.clients.find(client => client.name === name)
        if (row && JSON.stringify(row.config) === JSON.stringify(config)) continue
        await reconnectLiveMcp(name, config)
      }
    }),
  })
  registerCleanup(async () => {
    liveMcp.stop()
    for (const flow of mcpSignIns.values()) flow.controller.abort()
  })
  return { resolveServerConfigFromAllSources, applyReconnectedClient, mcpSignIns, permittedMcpConfig, reconnectLiveMcp, liveMcp }
}

export const watchLiveMcp: BootStep<'resolveServerConfigFromAllSources' | 'applyReconnectedClient' | 'mcpSignIns' | 'permittedMcpConfig' | 'reconnectLiveMcp' | 'liveMcp'> = { name: 'watchLiveMcp', makes: ['resolveServerConfigFromAllSources', 'applyReconnectedClient', 'mcpSignIns', 'permittedMcpConfig', 'reconnectLiveMcp', 'liveMcp'], run }
