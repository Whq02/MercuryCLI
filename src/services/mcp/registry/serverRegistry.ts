/**
 * McpServerRegistry — the owned, non-React MCP connection control plane.
 *
 * ONE registry owns every per-server state machine:
 *
 *   pending → connecting → connected | needs-auth | failed | disabled
 *                 ↑ auto-reconnect loop (exponential backoff, disk-disabled
 *                   checked between attempts) · manual reconnect · toggle
 *
 * Architecture (the program's shared rules):
 *   • ONE OWNER per server — every intent (connect · connection-lost ·
 *     manual reconnect · toggle · shutdown) runs through a per-server op
 *     chain; two intents can never interleave their awaits. This closes the
 *     residual (manual-vs-auto overlap) by construction.
 *   • GENERATIONS — every accepted intent bumps the server's generation; a
 *     completion whose generation is stale (a toggle/shutdown/manual arrived
 *     while it was in flight) is DISCARDED with an explicit 'stale-drop'
 *     event, never applied.
 *   • ONE RETRY OWNER — the auto-reconnect loop is a single owned op;
 *     a second connection-lost signal while a loop is active is a no-op.
 *   • STABLE EVENT ENVELOPES — { seq, name, generation, cause, connection,
 *     tools?, commands?, resources? }; seq strictly increasing; a snapshot
 *     getter serves late subscribers. The React layer is a SUBSCRIBER that
 *     projects into AppState — it owns no lifecycle.
 *   • EFFECTS BEHIND PORTS — connect impl, disconnect/cache-clear, the
 *     disk-enabled store, and the backoff sleep are injected
 *     (defaultRegistryPorts binds the live client.ts machinery); tests drive
 *     the machine hermetically.
 *
 * The transport-level onclose signal and the MCP notification handlers stay
 * in the adapter that holds the live Client object; the adapter reports
 * `connectionLost(name)` / `applyServerUpdate(...)` back into the registry so
 * every state transition still flows through one place.
 */
import type { Command } from '../../../commands.js'
import type { Tool } from '../../../Tool.js'
import { logMCPDebug, logMCPError } from '../../../utils/log.js'
import { errorMessage } from '../../../utils/errors.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../types.js'

export const MAX_RECONNECT_ATTEMPTS = 5
export const INITIAL_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 30000

/** The settled result of one connect attempt (the reconnectMcpServerImpl
 *  shape — connection + the fetched projection payload). */
export interface McpConnectOutcome {
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}

export type McpRegistryCause =
  | 'seed'
  | 'connect'
  | 'reconnect-auto'
  | 'reconnect-manual'
  | 'toggle'
  | 'update'
  | 'stale-drop'
  | 'shutdown'

/** The stable event envelope. `connection` is the full live union record
 *  (the AppState `mcp.clients` vocabulary); tools/commands/resources are
 *  present when the transition carries a projection payload (undefined =
 *  preserve existing, mirroring the legacy updateServer contract). */
export interface McpRegistryEvent {
  seq: number
  name: string
  generation: number
  cause: McpRegistryCause
  connection: MCPServerConnection
  tools?: Tool[]
  commands?: Command[]
  resources?: ServerResource[]
}

export interface McpRegistryPorts {
  /** One full connect attempt: cache clear + connect + capability fetches
   *  (the reconnectMcpServerImpl contract — never throws, returns failed). */
  connect(name: string, config: ScopedMcpServerConfig): Promise<McpConnectOutcome>
  /** The initial mass-connect path (the getMcpToolsCommandsAndResources
   *  contract): batched concurrency, cross-server resource-tool dedup, per
   *  settle callback. Settles route back through the registry's generation
   *  checks — a stale batch settle is discarded like any other. */
  connectMany(
    configs: Record<string, ScopedMcpServerConfig>,
    onSettle: (outcome: McpConnectOutcome) => void,
  ): Promise<void>
  /** Tear down a live connection + its caches (clearServerCache contract). */
  disconnect(name: string, config: ScopedMcpServerConfig): Promise<void>
  /** The persisted enable/disable store (disk truth — checked between
   *  reconnect attempts exactly as the legacy loop did). */
  isDisabledOnDisk(name: string): boolean
  setEnabledOnDisk(name: string, enabled: boolean): void
  /** Abortable backoff sleep (injected clock — tests run it virtually). */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

interface ServerSlot {
  name: string
  config: ScopedMcpServerConfig
  connection: MCPServerConnection
  generation: number
  /** The per-server op chain — the single owner of every await. */
  chain: Promise<void>
  /** Set while the auto-reconnect loop owns the slot (one retry owner). */
  retryLoopActive: boolean
  /** Single-flight for plain connect intents: a duplicate `connect` while one
   *  is queued/running coalesces onto the same op (manual reconnects always
   *  supersede instead). */
  connectInFlight: Promise<McpConnectOutcome | null> | null
  /** Aborts the current backoff sleep when a newer intent lands. */
  wakeup: AbortController | null
}

export type McpRegistryListener = (event: McpRegistryEvent) => void

export class McpServerRegistry {
  private slots = new Map<string, ServerSlot>()
  private listeners = new Set<McpRegistryListener>()
  private seq = 0
  private shutdownFlag = false

  constructor(private ports: McpRegistryPorts) {}

  // ── subscription + projection ─────────────────────────────────────────────

  subscribe(listener: McpRegistryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The current connection records (the AppState `mcp.clients` shape). */
  snapshot(): MCPServerConnection[] {
    return [...this.slots.values()].map(s => s.connection)
  }

  get(name: string): MCPServerConnection | undefined {
    return this.slots.get(name)?.connection
  }

  generationOf(name: string): number {
    return this.slots.get(name)?.generation ?? 0
  }

  private emit(
    slot: ServerSlot,
    cause: McpRegistryCause,
    payload?: Pick<McpRegistryEvent, 'tools' | 'commands' | 'resources'>,
  ): void {
    const event: McpRegistryEvent = {
      seq: ++this.seq,
      name: slot.name,
      generation: slot.generation,
      cause,
      connection: slot.connection,
      ...(payload ?? {}),
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (e) {
        logMCPError(slot.name, `registry listener failed: ${errorMessage(e)}`)
      }
    }
  }

  // ── slot + op-chain plumbing ──────────────────────────────────────────────

  private slotFor(name: string, config: ScopedMcpServerConfig): ServerSlot {
    let slot = this.slots.get(name)
    if (!slot) {
      slot = {
        name,
        config,
        connection: { name, type: 'pending', config },
        generation: 0,
        chain: Promise.resolve(),
        retryLoopActive: false,
        connectInFlight: null,
        wakeup: null,
      }
      this.slots.set(name, slot)
    }
    return slot
  }

  /** Enqueue an op on the server's chain — the one-owner discipline. The op
   *  receives the generation it was accepted under; it must re-check
   *  `slot.generation === gen` after every await before applying anything.
   *  Resolves with the op's value (null when shut down or the op failed —
   *  ops never reject by contract; the catch is belt-and-suspenders so one
   *  throw can't wedge the server forever). */
  private enqueue<R>(
    slot: ServerSlot,
    op: (gen: number) => Promise<R | null>,
  ): Promise<R | null> {
    const gen = ++slot.generation
    // A newer intent invalidates any backoff sleep in progress.
    slot.wakeup?.abort()
    const run: Promise<R | null> = slot.chain
      .then(() => (this.shutdownFlag ? null : op(gen)))
      .catch(e => {
        logMCPError(slot.name, `registry op failed: ${errorMessage(e)}`)
        return null
      })
    slot.chain = run.then(() => undefined)
    return run
  }

  private stale(slot: ServerSlot, gen: number, what: string): boolean {
    if (this.shutdownFlag) return true
    if (slot.generation !== gen) {
      logMCPDebug(
        slot.name,
        `discarding stale ${what} (gen ${gen} < ${slot.generation})`,
      )
      this.emit(slot, 'stale-drop')
      return true
    }
    return false
  }

  // ── intents ───────────────────────────────────────────────────────────────

  /** Seed records without connecting (the init-as-pending pass). */
  seed(configs: Record<string, ScopedMcpServerConfig>): void {
    for (const [name, config] of Object.entries(configs)) {
      if (this.slots.has(name)) continue
      const slot = this.slotFor(name, config)
      slot.connection = this.ports.isDisabledOnDisk(name)
        ? { name, type: 'disabled', config }
        : { name, type: 'pending', config }
      this.emit(slot, 'seed')
    }
  }

  /** Connect one server (initial connect or an external retry request).
   *  Coalesces: if the slot's chain already has a connect in flight for the
   *  same generation lineage, the enqueue discipline serializes them and the
   *  second run sees an up-to-date phase. */
  connect(
    name: string,
    config: ScopedMcpServerConfig,
    cause: 'connect' | 'reconnect-manual' = 'connect',
  ): Promise<McpConnectOutcome | null> {
    const slot = this.slotFor(name, config)
    // Duplicate-connect single-flight: a second plain connect while one is
    // queued/running joins it (the connect port is called ONCE); a manual
    // reconnect always supersedes (generation bump discards the older op).
    if (cause === 'connect' && slot.connectInFlight) {
      return slot.connectInFlight
    }
    slot.config = config
    const run = this.enqueue<McpConnectOutcome>(slot, async gen => {
      if (this.ports.isDisabledOnDisk(name)) {
        slot.connection = { name, type: 'disabled', config: slot.config }
        this.emit(slot, cause, { tools: [], commands: [] })
        return null
      }
      // Duplicate-connect coalescing: an identical intent that queued behind
      // a completed connect finds the slot already connected and yields.
      if (cause === 'connect' && slot.connection.type === 'connected') {
        return null
      }
      slot.connection = { name, type: 'pending', config: slot.config }
      this.emit(slot, cause)
      const outcome = await this.ports.connect(name, slot.config)
      if (this.stale(slot, gen, `${cause} completion`)) return null
      slot.connection = outcome.client
      this.emit(slot, cause, {
        tools: outcome.tools,
        commands: outcome.commands,
        resources: outcome.resources,
      })
      return outcome
    })
    if (cause === 'connect') {
      slot.connectInFlight = run
      void run.finally(() => {
        if (slot.connectInFlight === run) slot.connectInFlight = null
      })
    }
    return run
  }

  /** The initial mass-connect: seeds/updates slot configs, assigns each a
   *  fresh generation, and routes every batch settle through the same
   *  stale-discard discipline (a toggle/manual intent that lands mid-batch
   *  wins over the batch settle for that server). */
  connectAll(configs: Record<string, ScopedMcpServerConfig>): Promise<void> {
    const gens = new Map<string, number>()
    for (const [name, config] of Object.entries(configs)) {
      const slot = this.slotFor(name, config)
      slot.config = config
      gens.set(name, ++slot.generation)
      slot.wakeup?.abort()
    }
    return this.ports.connectMany(configs, outcome => {
      const name = outcome.client.name
      const slot = this.slots.get(name)
      if (!slot) return
      if (this.shutdownFlag || slot.generation !== gens.get(name)) {
        this.emit(slot, 'stale-drop')
        return
      }
      // Synchronous apply — no awaits, so it cannot interleave with a
      // chained op's awaits; any newer intent already bumped the generation.
      slot.connection = outcome.client
      this.emit(slot, 'connect', {
        tools: outcome.tools,
        commands: outcome.commands,
        resources: outcome.resources,
      })
    })
  }

  /** The transport-level onclose signal. Starts the ONE auto-reconnect loop
   *  (exponential backoff), unless the loop is already active, the server is
   *  disabled on disk, or the transport can't reconnect (stdio/sdk). */
  connectionLost(name: string): Promise<void> {
    const slot = this.slots.get(name)
    if (!slot) return Promise.resolve()
    const configType = slot.config.type ?? 'stdio'
    if (this.ports.isDisabledOnDisk(name)) {
      logMCPDebug(name, 'server is disabled, skipping automatic reconnection')
      return Promise.resolve()
    }
    if (configType === 'stdio' || configType === 'sdk') {
      // Local processes don't support reconnection — terminal failed.
      return this.enqueue(slot, async gen => {
        if (this.stale(slot, gen, 'connection-lost')) return null
        // The failed row carries its reason: the server ended its own
        // connection, and a local process is not reconnected on its own.
        slot.connection = {
          name,
          type: 'failed',
          config: slot.config,
          error: `the server closed its connection — a local server is not restarted on its own; /mcp reconnect ${name} starts it again`,
        }
        this.emit(slot, 'reconnect-auto', { tools: [], commands: [] })
        return null
      }).then(() => undefined)
    }
    if (slot.retryLoopActive) {
      // ONE retry owner: a second onclose while the loop runs is a no-op.
      logMCPDebug(name, 'reconnect loop already active, ignoring signal')
      return Promise.resolve()
    }
    slot.retryLoopActive = true
    return this.enqueue(slot, async gen => {
      try {
        for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
          if (this.stale(slot, gen, 'reconnect loop')) return null
          if (this.ports.isDisabledOnDisk(name)) {
            logMCPDebug(name, 'server disabled during reconnection, stopping retry')
            return null
          }
          slot.connection = {
            name,
            type: 'pending',
            config: slot.config,
            reconnectAttempt: attempt,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
          }
          this.emit(slot, 'reconnect-auto')
          const outcome = await this.ports.connect(name, slot.config)
          if (this.stale(slot, gen, 'reconnect completion')) return null
          if (outcome.client.type === 'connected') {
            slot.connection = outcome.client
            this.emit(slot, 'reconnect-auto', {
              tools: outcome.tools,
              commands: outcome.commands,
              resources: outcome.resources,
            })
            return null
          }
          if (attempt === MAX_RECONNECT_ATTEMPTS) {
            logMCPDebug(
              name,
              `max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
            )
            slot.connection = outcome.client
            this.emit(slot, 'reconnect-auto', {
              tools: outcome.tools,
              commands: outcome.commands,
              resources: outcome.resources,
            })
            return null
          }
          const backoffMs = Math.min(
            INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1),
            MAX_BACKOFF_MS,
          )
          logMCPDebug(name, `scheduling reconnection attempt ${attempt + 1} in ${backoffMs}ms`)
          slot.wakeup = new AbortController()
          try {
            await this.ports.sleep(backoffMs, slot.wakeup.signal)
          } finally {
            slot.wakeup = null
          }
          // A wakeup abort means a newer intent landed — the generation check
          // at the top of the next iteration discards this loop.
        }
        return null
      } finally {
        slot.retryLoopActive = false
      }
    }).then(() => undefined)
  }

  /** Persisted enable/disable. Disable persists to disk FIRST (the onclose
   *  handler reads disk truth), then tears the connection down; enable
   *  persists, then connects. */
  toggle(name: string): Promise<void> {
    const slot = this.slots.get(name)
    if (!slot) {
      return Promise.reject(new Error(`MCP server ${name} not found`))
    }
    const currentlyDisabled = slot.connection.type === 'disabled'
    if (!currentlyDisabled) {
      this.ports.setEnabledOnDisk(name, false)
      const wasConnected = slot.connection
      return this.enqueue(slot, async gen => {
        if (wasConnected.type === 'connected') {
          await this.ports.disconnect(name, slot.config)
        }
        if (this.stale(slot, gen, 'disable')) return null
        slot.connection = { name, type: 'disabled', config: slot.config }
        this.emit(slot, 'toggle', { tools: [], commands: [] })
        return null
      }).then(() => undefined)
    }
    this.ports.setEnabledOnDisk(name, true)
    return this.enqueue(slot, async gen => {
      slot.connection = { name, type: 'pending', config: slot.config }
      this.emit(slot, 'toggle')
      const outcome = await this.ports.connect(name, slot.config)
      if (this.stale(slot, gen, 'enable completion')) return null
      slot.connection = outcome.client
      this.emit(slot, 'toggle', {
        tools: outcome.tools,
        commands: outcome.commands,
        resources: outcome.resources,
      })
      return null
    }).then(() => undefined)
  }

  /** Adapter-reported refresh (list_changed refetches, readmission results).
   *  Keeps every projection change flowing through the registry. */
  applyServerUpdate(
    name: string,
    payload: Pick<McpRegistryEvent, 'tools' | 'commands' | 'resources'>,
  ): void {
    const slot = this.slots.get(name)
    if (!slot || this.shutdownFlag) return
    this.emit(slot, 'update', payload)
  }

  /** Remove servers whose config vanished/changed (the stale-extension pass).
   *  The caller supplies the survivors; removed CONNECTED servers get their
   *  disconnect port called (never-connected ones must not — the legacy
   *  hazard-3 rule: cache-clear on a cold server would spawn just to kill). */
  removeStale(liveNames: Set<string>): Promise<void> {
    const removals: Promise<void>[] = []
    for (const [name, slot] of [...this.slots.entries()]) {
      if (liveNames.has(name)) continue
      slot.generation++ // invalidate anything in flight
      slot.wakeup?.abort()
      const conn = slot.connection
      this.slots.delete(name)
      if (conn.type === 'connected') {
        removals.push(
          this.ports.disconnect(name, slot.config).catch(() => {}),
        )
      }
    }
    return Promise.all(removals).then(() => {})
  }

  /** Terminal: invalidate every slot, abort sleeps, stop emitting. */
  shutdown(): void {
    this.shutdownFlag = true
    for (const slot of this.slots.values()) {
      slot.generation++
      slot.wakeup?.abort()
    }
  }
}
