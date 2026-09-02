/**
 * The React adapter between resolved MCP configuration, the connection
 * registry (the out-of-slice lifecycle owner) and application state.
 *
 * The hook owns NO reconnect machinery of its own: connection loss routes
 * into `registry.connectionLost`, which owns the disk-disabled check, the
 * stdio/SDK terminal-failure rule, and the single backoff loop. What lives
 * here is seeding, the two-phase connect, event projection with 16 ms
 * batching, per-connection wiring, the list-changed re-admission gate, the
 * local channel bus + presence heartbeat, and error de-duplication.
 */
import * as React from 'react'

import { getSessionId } from '../../bootstrap/state.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { getBranch } from '../../utils/git.js'
import { logMCPError } from '../../utils/log.js'
import { getOperatorName, recordSelfPresence, tailPresence } from '../../utils/cockpit/presenceLive.js'
import { clearClaudeAIMcpConfigsCache, fetchClaudeAIMcpConfigsIfEligible } from './claudeai.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
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
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from './sdk.js'

const HOOK_LABEL = 'useManageMCPConnections'
const BATCH_WINDOW_MS = 16
const PRESENCE_HEARTBEAT_MS = 3000
const PRESENCE_TAIL_MS = 2000

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

  // ── batching ──────────────────────────────────────────────────────────────

  const pendingUpdatesRef = React.useRef<PendingUpdate[]>([])
  const flushTimerRef = React.useRef<NodeJS.Timeout | null>(null)

  const flushUpdates = React.useCallback((): void => {
    // Clear the handle first, then drain; an empty queue performs NO write.
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
            // The audited behaviour, reproduced deliberately: the without-key
            // map is merged back OVER the existing map, which re-adds every
            // other key and leaves this server's previous entry in place. A
            // failed/disabled update therefore clears tools and commands but
            // RETAINS stale resources (the fix
            // is an operator decision, not an implementer one).
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
      // A short TIMER, not a microtask: connection settles arrive across real
      // network round-trips, so a microtask window would batch nothing.
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flushUpdates, BATCH_WINDOW_MS)
      }
    },
    [flushUpdates],
  )

  // ── the list-changed re-admission gate ───────────────────────────────────

  /** server → hash of the toolset that was last ADMITTED (post-filter).
   *  Starts empty — the first list_changed after a connect always re-runs
   *  the filter. Written ONLY by the gate. */
  const admittedToolsetHashesRef = React.useRef(new Map<string, string>())

  const gateRefetchedTools = React.useCallback(
    (serverName: string, refetched: Tool[]): Tool[] => {
      try {
        const liveHash = toolsetHash(refetched as never)
        const admittedHash = admittedToolsetHashesRef.current.get(serverName)
        if (!needsReadmission(admittedHash, liveHash)) {
          // Unchanged: expose as-is; the recorded hash is left alone.
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
        // Defensive: a gate failure falls through to the refetched set.
        logForDebugging(
          `${HOOK_LABEL}: re-admission gate failed for "${serverName}" (${String(error)}); exposing the refetched set unchanged`,
        )
        return refetched
      }
    },
    [],
  )

  // ── per-connection wiring (run once per connect settle) ──────────────────

  const wireConnectedClient = React.useCallback(
    (client: ConnectedMCPServer): void => {
      registerElicitationHandler(client.client, client.name, setAppState)

      client.client.onclose = () => {
        // Invalidate the server's caches first (a failure is logged, never
        // thrown), then signal the loss to the registry, which owns the
        // disk-disabled check, the terminal-failure rule and the one backoff
        // loop.
        clearServerCache(client.name, client.config).catch(error => {
          logForDebugging(`${HOOK_LABEL}: cache invalidation on close failed: ${String(error)}`)
        })
        void registry.connectionLost(client.name)
      }

      // List-changed handlers — registered ONLY for the capabilities the
      // server actually advertises.
      const capabilities = client.capabilities as {
        tools?: { listChanged?: boolean }
        prompts?: { listChanged?: boolean }
        resources?: { listChanged?: boolean }
      }
      if (capabilities.tools?.listChanged) {
        client.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
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
        client.client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
          logForDebugging(`${HOOK_LABEL}: prompts/list_changed from "${client.name}"`)
          void (async () => {
            try {
              // Only the COMMAND cache: skills come from resources, so their
              // cache must not be invalidated here.
              fetchCommandsForClient.cache.delete(client.name)
              // The prompt refetch runs concurrently with the MCP-skill fetch;
              // the skill half is folded out in this build and resolves empty,
              // and the skill-search-index invalidation seam is bound to
              // nothing — both call sites are kept, neither is synthesised.
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
        client.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
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

  // ── projection ───────────────────────────────────────────────────────────

  React.useEffect(() => {
    const unsubscribe = registry.subscribe((event: McpRegistryEvent) => {
      if (event.cause === 'stale-drop' || event.cause === 'shutdown') return
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
      // Shut the registry down; flush any pending batch synchronously so no
      // update is lost, and leave no timer behind.
      registry.shutdown()
      if (flushTimerRef.current !== null) {
        flushUpdates()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring
  }, [])

  // ── resolution notices ───────────────────────────────────────────────────

  const publishResolutionErrors = React.useCallback((notices: McpResolutionNotice[]): void => {
    // A suppressed duplicate is informational: the health owner paints the
    // extension's row from the live client states; the notice goes to the log.
    for (const notice of notices) logForDebugging(`mcp: ${notice.message}`)
  }, [])

  // ── seeding + the two-phase connect ──────────────────────────────────────

  // The session id is process-level truth (a /clear remounts the tree, so
  // the effect re-evaluates it); auth version and the extension-reload counter
  // are reactive app state selected above.
  const sessionId = getSessionId()

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The connector cache is cleared so the fetch reflects the current
        // authentication state — except under enterprise exclusivity or
        // strict mode, where no fetch is made at all.
        const strict = isStrictMcpConfig === true
        const skipConnectors = strict || doesEnterpriseMcpConfigExist()
        if (!skipConnectors) clearClaudeAIMcpConfigsCache()
        // Phase 2's fetch is STARTED before phase 1 so the two overlap; the
        // memo makes the later await a cache hit.
        const connectorFetch = skipConnectors
          ? Promise.resolve({} as Record<string, ScopedMcpServerConfig>)
          : fetchClaudeAIMcpConfigsIfEligible()

        // Phase 1 — resolve Mercury-side configuration.
        const resolved = strict
          ? { servers: {} as Record<string, ScopedMcpServerConfig>, errors: [] as McpResolutionNotice[] }
          : await getMercuryMcpConfigs(dynamicMcpConfig)
        if (cancelled) return
        const merged: Record<string, ScopedMcpServerConfig> = {
          ...resolved.servers,
          ...(dynamicMcpConfig ?? {}),
        }
        publishResolutionErrors(resolved.errors)

        // One synchronous update: drop stale clients and add newcomers as
        // disabled/pending; identity-preserving when nothing changed.
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

        // Lifecycle removal as a KEEP set: current snapshot minus the stale
        // names; the registry drops everything else (rejection swallowed).
        const keep = new Set(registry.snapshot().map(connection => connection.name))
        for (const name of staleNames) keep.delete(name)
        registry.removeStale(keep).catch(() => {})

        // Seed unconditionally with the full merged config, disabled included.
        registry.seed(merged)

        // Begin connecting every non-disabled entry; completion NOT awaited.
        const connectable: Record<string, ScopedMcpServerConfig> = {}
        for (const [name, config] of Object.entries(merged)) {
          if (isMcpCatalogueMember(name)) connectable[name] = config
        }
        if (Object.keys(connectable).length > 0) {
          void registry.connectAll(connectable)
        }

        // Phase 2 — connectors (a cache hit on the promise started above).
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
        // The per-scope tally the audited snapshot discards is omitted — its
        // analytics sink is folded out; no destination is invented.
      } catch (error) {
        logMCPError(HOOK_LABEL, `configuration load failed: ${String(error)}`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the documented re-run set
  }, [sessionId, authVersion, extensionReloadCounter, dynamicMcpConfig, isStrictMcpConfig])

  // ── the local channel bus + presence heartbeat (one gated effect) ────────

  React.useEffect(() => {
    // The bus predicate is OWNED by the local-channel-bus module — never
    // re-implemented here. With both flags unset it answers true (the bus
    // module itself degrades to a no-op when no room directory exists).
    if (!isLocalChannelBusEnabled()) return
    const bus = startLocalChannelBus()

    // The presence path may ONLY record and tail presence — it must never
    // reach the inbox, the enqueue path or the ingest path.
    const seat = getOperatorName()
    let branch = ''
    const publish = (): void => {
      recordSelfPresence({ seat, verb: 'active', branch, lastLine: '' })
    }
    publish()
    // The branch is read ONCE per mount from the cached source (never a
    // process per tick) and re-published when it resolves; a detached head
    // reads as empty and a failed read is swallowed.
    void Promise.resolve()
      .then(() => getBranch())
      .then(resolved => {
        branch = resolved ?? ''
        publish()
      })
      .catch(() => {})
    const heartbeat = setInterval(publish, PRESENCE_HEARTBEAT_MS)
    heartbeat.unref?.()
    const tail = setInterval(() => {
      tailPresence()
    }, PRESENCE_TAIL_MS)
    tail.unref?.()

    return () => {
      clearInterval(heartbeat)
      clearInterval(tail)
      bus.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per session
  }, [])

  // ── exposed operations ───────────────────────────────────────────────────

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
        // Superseded or stale: report the registry's current record with
        // empty tool/command lists rather than failing.
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
    // The registry persists the disk state FIRST and only then tears down or
    // reconnects — the close handler's disk-disabled check depends on it.
    (name: string): Promise<void> => registry.toggle(name),
    [registry],
  )

  return { reconnectMcpServer, toggleMcpServer }
}
