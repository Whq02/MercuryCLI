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
  connect(name: string, config: ScopedMcpServerConfig): Promise<McpConnectOutcome>
  connectMany(
    configs: Record<string, ScopedMcpServerConfig>,
    onSettle: (outcome: McpConnectOutcome) => void,
  ): Promise<void>
  disconnect(name: string, config: ScopedMcpServerConfig): Promise<void>
  isDisabledOnDisk(name: string): boolean
  setEnabledOnDisk(name: string, enabled: boolean): void
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

interface ServerSlot {
  name: string
  config: ScopedMcpServerConfig
  connection: MCPServerConnection
  generation: number
  chain: Promise<void>
  retryLoopActive: boolean
  connectInFlight: Promise<McpConnectOutcome | null> | null
  wakeup: AbortController | null
}

export type McpRegistryListener = (event: McpRegistryEvent) => void

export class McpServerRegistry {
  private slots = new Map<string, ServerSlot>()
  private listeners = new Set<McpRegistryListener>()
  private seq = 0
  private shutdownFlag = false

  constructor(private ports: McpRegistryPorts) {}


  subscribe(listener: McpRegistryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

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

  private enqueue<R>(
    slot: ServerSlot,
    op: (gen: number) => Promise<R | null>,
  ): Promise<R | null> {
    const gen = ++slot.generation
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

  connect(
    name: string,
    config: ScopedMcpServerConfig,
    cause: 'connect' | 'reconnect-manual' = 'connect',
  ): Promise<McpConnectOutcome | null> {
    const slot = this.slotFor(name, config)
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
      slot.connection = outcome.client
      this.emit(slot, 'connect', {
        tools: outcome.tools,
        commands: outcome.commands,
        resources: outcome.resources,
      })
    })
  }

  connectionLost(name: string): Promise<void> {
    const slot = this.slots.get(name)
    if (!slot) return Promise.resolve()
    const configType = slot.config.type ?? 'stdio'
    if (this.ports.isDisabledOnDisk(name)) {
      logMCPDebug(name, 'server is disabled, skipping automatic reconnection')
      return Promise.resolve()
    }
    if (configType === 'stdio' || configType === 'sdk') {
      return this.enqueue(slot, async gen => {
        if (this.stale(slot, gen, 'connection-lost')) return null
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
        }
        return null
      } finally {
        slot.retryLoopActive = false
      }
    }).then(() => undefined)
  }

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

  applyServerUpdate(
    name: string,
    payload: Pick<McpRegistryEvent, 'tools' | 'commands' | 'resources'>,
  ): void {
    const slot = this.slots.get(name)
    if (!slot || this.shutdownFlag) return
    this.emit(slot, 'update', payload)
  }

  removeStale(liveNames: Set<string>): Promise<void> {
    const removals: Promise<void>[] = []
    for (const [name, slot] of [...this.slots.entries()]) {
      if (liveNames.has(name)) continue
      slot.generation++
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

  shutdown(): void {
    this.shutdownFlag = true
    for (const slot of this.slots.values()) {
      slot.generation++
      slot.wakeup?.abort()
    }
  }
}
