import * as React from 'react'

import { getSessionId } from '../../bootstrap/state.js'
import { processMainOwner } from '../run/resolveOwner.js'
import { requestDeliberateToolChange } from '../providers/lawfulPrefixChange.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { getBranch } from '../../utils/git.js'
import { logMCPError } from '../../utils/log.js'
import { getOperatorName, recordSelfPresence, startPresenceTail } from '../../utils/cockpit/presenceLive.js'
import { subscribeUiClock } from '../../utils/cockpit/uiClock.js'
import { clearClaudeAIMcpConfigsCache, fetchClaudeAIMcpConfigsIfEligible } from './claudeai.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  onMcpListChanged,
} from './client.js'
import {
  dedupClaudeAiMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getMercuryMcpConfigs,
} from './config.js'
import { isMcpCatalogueMember } from './membership.js'
import { registerElicitationHandler } from './elicitationHandler.js'
import { isLocalChannelBusEnabled, startLocalChannelBus } from './localChannelBus.js'
import { liveMcpRegistryPorts } from './registry/livePorts.js'
import {
  McpServerRegistry,
  type McpConnectOutcome,
  type McpRegistryEvent,
} from './registry/serverRegistry.js'
import { needsReadmission, readmitTools, toolsetHash } from './toolsetReadmission.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig, ServerResource } from './types.js'
import type { McpResolutionNotice } from './config.js'
import { excludeCommandsByServer, excludeResourcesByServer, excludeStaleExtensionClients, excludeToolsByServer } from './utils.js'

const HOOK_LABEL = 'useManageMCPConnections'
const BATCH_WINDOW_MS = 16
const PRESENCE_HEARTBEAT_MS = 3000

type Tool = McpConnectOutcome['tools'][number]
type Command = McpConnectOutcome['commands'][number]

type PendingUpdate = {
  connection: MCPServerConnection
  tools?: Tool[]
  commands?: Command[]
  resources?: ServerResource[]
}

export function useManageMCPConnections(
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined,
  isStrictMcpConfig?: boolean,
): {
  reconnectMcpServer: (name: string) => Promise<{
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
  }>
  toggleMcpServer: (name: string) => Promise<void>
} {
  const authVersion = useAppState((state: AppState) => state.authVersion)
  const extensionReloadCounter = useAppState((state: AppState) => state.mcp.extensionReconnectKey)
  const setAppState = useSetAppState()
  const registryRef = React.useRef<McpServerRegistry | null>(null)
  if (registryRef.current === null) {
    registryRef.current = new McpServerRegistry(liveMcpRegistryPorts())
  }
  const registry = registryRef.current


  const pendingUpdatesRef = React.useRef<PendingUpdate[]>([])
  const flushTimerRef = React.useRef<NodeJS.Timeout | null>(null)

  const flushUpdates = React.useCallback((): void => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const updates = pendingUpdatesRef.current
    if (updates.length === 0) return
    pendingUpdatesRef.current = []
    setAppState(prev => {
      let clients = prev.mcp.clients
      let tools = prev.mcp.tools
      let commands = prev.mcp.commands
      let resources = prev.mcp.resources
      for (const update of updates) {
        const name = update.connection.name
        const cleared = update.connection.type === 'disabled' || update.connection.type === 'failed'
        const nextTools = update.tools ?? (cleared ? [] : undefined)
        const nextCommands = update.commands ?? (cleared ? [] : undefined)
        const nextResources = update.resources ?? (cleared ? [] : undefined)
        if (nextTools !== undefined) {
          tools = [...excludeToolsByServer(tools, name), ...nextTools]
        }
        if (nextCommands !== undefined) {
          commands = [...excludeCommandsByServer(commands, name), ...nextCommands]
        }
        if (nextResources !== undefined) {
          if (nextResources.length > 0) {
            resources = { ...resources, [name]: nextResources }
          } else {
            resources = { ...resources, ...excludeResourcesByServer(resources, name) }
          }
        }
        const existingIndex = clients.findIndex(client => client.name === name)
        if (existingIndex === -1) {
          clients = [...clients, update.connection]
        } else {
          clients = [...clients]
          clients[existingIndex] = update.connection
        }
      }
      return { ...prev, mcp: { ...prev.mcp, clients, tools, commands, resources } }
    })
  }, [setAppState])

  const queueUpdate = React.useCallback(
    (update: PendingUpdate): void => {
      pendingUpdatesRef.current.push(update)
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flushUpdates, BATCH_WINDOW_MS)
      }
    },
    [flushUpdates],
  )


  const admittedToolsetHashesRef = React.useRef(new Map<string, string>())

  const gateRefetchedTools = React.useCallback(
    (serverName: string, refetched: Tool[]): Tool[] => {
      try {
        const liveHash = toolsetHash(refetched as never)
        const admittedHash = admittedToolsetHashesRef.current.get(serverName)
        if (!needsReadmission(admittedHash, liveHash)) {
          return refetched
        }
        const admitted = readmitTools(serverName, refetched as never) as Tool[]
        if (admitted.length < refetched.length) {
          logForDebugging(
            `${HOOK_LABEL}: re-admission denied ${refetched.length - admitted.length} tool(s) for "${serverName}" (MERCURY_MCP_MAX_RISK; ${admitted.length}/${refetched.length} admitted)`,
          )
        }
        admittedToolsetHashesRef.current.set(serverName, toolsetHash(admitted as never))
        return admitted
      } catch (error) {
        logForDebugging(
          `${HOOK_LABEL}: re-admission gate failed for "${serverName}" (${String(error)}); exposing the refetched set unchanged`,
        )
        return refetched
      }
    },
    [],
  )


  const wireConnectedClient = React.useCallback(
    (client: ConnectedMCPServer): void => {
      registerElicitationHandler(client.client, client.name, setAppState)

      client.client.onclose = () => {
        clearServerCache(client.name, client.config).catch(error => {
          logForDebugging(`${HOOK_LABEL}: cache invalidation on close failed: ${String(error)}`)
        })
        void registry.connectionLost(client.name)
      }

      const capabilities = client.capabilities as {
        tools?: { listChanged?: boolean }
        prompts?: { listChanged?: boolean }
        resources?: { listChanged?: boolean }
      }
      if (capabilities.tools?.listChanged) {
        onMcpListChanged(client.client, 'tools', () => {
          logForDebugging(`${HOOK_LABEL}: tools/list_changed from "${client.name}"`)
          void (async () => {
            try {
              fetchToolsForClient.cache.delete(client.name)
              const refetched = await fetchToolsForClient(client)
              const admitted = gateRefetchedTools(client.name, refetched as Tool[])
              registry.applyServerUpdate(client.name, { tools: admitted as never })
            } catch (error) {
              logMCPError(client.name, `tools refetch after list_changed failed: ${String(error)}`)
            }
          })()
        })
      }
      if (capabilities.prompts?.listChanged) {
        onMcpListChanged(client.client, 'prompts', () => {
          logForDebugging(`${HOOK_LABEL}: prompts/list_changed from "${client.name}"`)
          void (async () => {
            try {
              fetchCommandsForClient.cache.delete(client.name)
              const [prompts, skills] = await Promise.all([
                fetchCommandsForClient(client),
                Promise.resolve([] as Command[]),
              ])
              registry.applyServerUpdate(client.name, {
                commands: [...prompts, ...skills] as never,
              })
            } catch (error) {
              logMCPError(
                client.name,
                `prompts refetch after list_changed failed: ${String(error)}`,
              )
            }
          })()
        })
      }
      if (capabilities.resources?.listChanged) {
        onMcpListChanged(client.client, 'resources', () => {
          logForDebugging(`${HOOK_LABEL}: resources/list_changed from "${client.name}"`)
          void (async () => {
            try {
              fetchResourcesForClient.cache.delete(client.name)
              const refetched = await fetchResourcesForClient(client)
              registry.applyServerUpdate(client.name, { resources: refetched })
            } catch (error) {
              logMCPError(
                client.name,
                `resources refetch after list_changed failed: ${String(error)}`,
              )
            }
          })()
        })
      }
    },
    [gateRefetchedTools, registry, setAppState],
  )


  React.useEffect(() => {
    const unsubscribe = registry.subscribe((event: McpRegistryEvent) => {
      if (event.cause === 'stale-drop' || event.cause === 'shutdown') return
      if (event.cause === 'reconnect-manual' && event.connection.type === 'connected' && event.tools !== undefined) {
        requestDeliberateToolChange(String(processMainOwner()), event.tools, `the MCP server ${event.name} was manually reconnected`)
      }
      if (
        event.connection.type === 'connected' &&
        event.tools !== undefined &&
        (event.cause === 'connect' ||
          event.cause === 'reconnect-auto' ||
          event.cause === 'reconnect-manual' ||
          event.cause === 'toggle')
      ) {
        wireConnectedClient(event.connection)
      }
      queueUpdate({
        connection: event.connection,
        ...(event.tools === undefined ? {} : { tools: event.tools as Tool[] }),
        ...(event.commands === undefined ? {} : { commands: event.commands as Command[] }),
        ...(event.resources === undefined ? {} : { resources: event.resources }),
      })
    })
    return () => {
      unsubscribe()
      registry.shutdown()
      if (flushTimerRef.current !== null) {
        flushUpdates()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring
  }, [])


  const publishResolutionErrors = React.useCallback((notices: McpResolutionNotice[]): void => {
    for (const notice of notices) logForDebugging(`mcp: ${notice.message}`)
  }, [])


  const sessionId = getSessionId()

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const strict = isStrictMcpConfig === true
        const skipConnectors = strict || doesEnterpriseMcpConfigExist()
        if (!skipConnectors) clearClaudeAIMcpConfigsCache()
        const connectorFetch = skipConnectors
          ? Promise.resolve({} as Record<string, ScopedMcpServerConfig>)
          : fetchClaudeAIMcpConfigsIfEligible()

        const resolved = strict
          ? { servers: {} as Record<string, ScopedMcpServerConfig>, errors: [] as McpResolutionNotice[] }
          : await getMercuryMcpConfigs(dynamicMcpConfig)
        if (cancelled) return
        const merged: Record<string, ScopedMcpServerConfig> = {
          ...resolved.servers,
          ...(dynamicMcpConfig ?? {}),
        }
        publishResolutionErrors(resolved.errors)

        let staleNames: string[] = []
        setAppState(prev => {
          const { state: pruned, staleClients } = excludeStaleExtensionClients(prev.mcp, merged)
          staleNames = staleClients.map(client => client.name)
          const known = new Set(pruned.clients.map(client => client.name))
          const newcomers: MCPServerConnection[] = []
          for (const [name, config] of Object.entries(merged)) {
            if (known.has(name)) continue
            newcomers.push(
              isMcpCatalogueMember(name)
                ? { name, type: 'pending', config }
                : { name, type: 'disabled', config },
            )
          }
          if (staleClients.length === 0 && newcomers.length === 0) return prev
          return {
            ...prev,
            mcp: { ...pruned, clients: [...pruned.clients, ...newcomers] },
          }
        })

        const keep = new Set(registry.snapshot().map(connection => connection.name))
        for (const name of staleNames) keep.delete(name)
        registry.removeStale(keep).catch(() => {})

        registry.seed(merged)

        const connectable: Record<string, ScopedMcpServerConfig> = {}
        for (const [name, config] of Object.entries(merged)) {
          if (isMcpCatalogueMember(name)) connectable[name] = config
        }
        if (Object.keys(connectable).length > 0) {
          void registry.connectAll(connectable)
        }

        const connectors = await connectorFetch
        if (cancelled) return
        if (Object.keys(connectors).length === 0) return
        const { allowed } = filterMcpServersByPolicy(connectors)
        const { servers: survivors } = dedupClaudeAiMcpServers(allowed, merged)
        if (Object.keys(survivors).length === 0) return
        registry.seed(survivors)
        const connectableConnectors: Record<string, ScopedMcpServerConfig> = {}
        for (const [name, config] of Object.entries(survivors)) {
          if (isMcpCatalogueMember(name)) connectableConnectors[name] = config
        }
        if (Object.keys(connectableConnectors).length > 0 && !cancelled) {
          void registry.connectAll(connectableConnectors)
        }
      } catch (error) {
        logMCPError(HOOK_LABEL, `configuration load failed: ${String(error)}`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the documented re-run set
  }, [sessionId, authVersion, extensionReloadCounter, dynamicMcpConfig, isStrictMcpConfig])


  React.useEffect(() => {
    if (!isLocalChannelBusEnabled()) return
    const bus = startLocalChannelBus()

    const seat = getOperatorName()
    let branch = ''
    const publish = (): void => {
      recordSelfPresence({ seat, verb: 'active', branch, lastLine: '' })
    }
    publish()
    void Promise.resolve()
      .then(() => getBranch())
      .then(resolved => {
        branch = resolved ?? ''
        publish()
      })
      .catch(() => {})
    const stopHeartbeat = subscribeUiClock(PRESENCE_HEARTBEAT_MS, publish)
    const stopTail = startPresenceTail()

    return () => {
      stopHeartbeat()
      stopTail()
      bus.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per session
  }, [])


  const reconnectMcpServer = React.useCallback(
    async (
      name: string,
    ): Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[] }> => {
      const current = registry.get(name)
      if (current === undefined) {
        throw new Error(`MCP server ${name} not found`)
      }
      const outcome = await registry.connect(name, current.config, 'reconnect-manual')
      if (outcome === null) {
        const record = registry.get(name)
        return {
          client: record ?? current,
          tools: [],
          commands: [],
        }
      }
      return { client: outcome.client, tools: outcome.tools, commands: outcome.commands }
    },
    [registry],
  )

  const toggleMcpServer = React.useCallback(
    (name: string): Promise<void> => registry.toggle(name),
    [registry],
  )

  return { reconnectMcpServer, toggleMcpServer }
}
