
import { DapCancelledError, throwIfDapAborted } from './dapCancellation.js'
import {
  registerOwnerDisposer,
  unregisterOwnerDisposer,
} from '../../engine/run-owner/ownerLifecycle.js'
import { registerExecutionDomain } from '../../engine/execution-plane/executionPlane.js'
import { projectExternalState } from '../../engine/execution-plane/externalProjection.js'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DapTerminalRunner } from './dapTerminal.js'
import { createServer as createNetServer, type Socket } from 'node:net'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { dormantBuiltinAdapterHints, envAdapterTableError, knownAdapterKeys, resolveAdapter } from './client/adapters.js'
import { dialListener, listenerAttachTarget, listenerRefusedLine } from './client/listener.js'
import type { DapStartOptions } from './client/launch.js'
import { FramePart } from './client/frame.js'
import { LifePart } from './client/life.js'
import { MessagesPart } from './client/messages.js'
import { OutputPart, pushOutput } from './client/output.js'
import { StartPart } from './client/start.js'
import { childBoundRefusal, ReversePart } from './client/reverse.js'
import { TerminalPart } from './client/terminal.js'
import { WirePart } from './client/wire.js'
import { drainOutput, waitForStop, waitForStopOutcome } from './client/stops.js'
import { treeTerminated } from './client/tree.js'
import {
  REQUEST_TIMEOUT_MS,
  type DapAdapterSpec,
  type DapBreakpointSpec,
  type DapFunctionBreakpointSpec,
  type DapListenerTarget,
  type StoppedInfo,
} from './client/shared.js'

export type {
  DapAdapterSpec,
  DapBreakpointSpec,
  DapBreakpointVerdict,
  DapDataAccessType,
  DapDataBreakpointInfo,
  DapDataBreakpointSpec,
  DapFunctionBreakpointSpec,
  DapInstructionBreakpointSpec,
  DapListenerTarget,
  DapWriteMemoryReceipt,
  StoppedInfo,
} from './client/shared.js'
export { listenerAttachTarget, listenerRefusedLine } from './client/listener.js'
export { _setDapChildBoundsForTesting } from './client/reverse.js'
export {
  _resetDarwinDebuggerAuthForTesting,
  _resetGdbProbeForTesting,
  _resetLldbDapForTesting,
  adapterSilenceMessage,
  darwinDebuggerAuthorisationHint,
  ELIXIR_DEBUG_ADAPTER_HINT,
  gdbInstallHint,
  gdbProbeFromMemo,
  KOTLIN_DEBUG_ADAPTER_HINT,
  lldbDapInstallHint,
  netcoredbgInstallHint,
  probeGdbDap,
  resolveLldbDap,
} from './client/probes.js'
export { jsDebugSourceLabel, resolveJsDebugServer } from './jsDebugResolver.js'
export {
  adapterKeyForExtension,
  dapAdapterProbePending,
  debugToolWithholding,
  dormantBuiltinAdapterHints,
  isDapToolCatalogEnabled,
  knownAdapterKeys,
  mercuryDapEnabled,
  reachableDapAdapterKeys,
  resolveAdapter,
  settleDapAdapterProbes,
} from './client/adapters.js'
import { DapSessionPublicLayer } from './client/publicLayer.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export class DapSession extends DapSessionPublicLayer {
  readonly adapterKey: string
  readonly program: string
  #spec: DapAdapterSpec
  #cwd: string
  #child: ChildProcessWithoutNullStreams | null
  #tcpPort: number | undefined
  #listener: DapListenerTarget | null = null
  #transportReady: Promise<void>
  #lifetime = new AbortController()
  #operationSignal: AbortSignal | undefined
  terminalCleanup = { ended: 0, survivors: [] as number[] }
  #wire = new WirePart({
    terminated: () => this.terminated,
    exitDetail: () => this.exitDetail,
    alive: () => this.alive,
    transportReady: () => this.#transportReady,
    child: () => this.#child,
    socketClosed: closedDetail => this.#life.socketClosed(closedDetail),
    onMessage: msg => this.#messages.onMessage(msg),
  })
  #terminal: TerminalPart = new TerminalPart({
    cwd: () => this.#cwd,
    rootRunner: () => this.root().#terminal.runner(),
    operationSignal: () => this.#operationSignal ?? this.root().#operationSignal,
    lifetimeSignal: () => this.#lifetime.signal,
    cleanup: () => this.terminalCleanup,
    pushOutput: line => this.#pushOutput(line),
    hostsDebuggee: () => {
      this.#hostsDebuggee = true
    },
  })
  #out = new OutputPart({ pushOutput: line => this.#pushOutput(line) })
  #reverse: ReversePart = new ReversePart({
    respondToReverse: (request, success, message, body) => this.#wire.respondToReverse(request, success, message, body),
    pushOutput: line => this.#pushOutput(line),
    childBoundRefusal: () => childBoundRefusal(this),
    createChildSession: configuration => this.#createChildSession(configuration),
    operationSignal: () => this.#operationSignal ?? this.root().#operationSignal,
    runChildDance: (child, requestKind, configuration) => child.#start.runChildDance(requestKind, configuration),
    runInTerminal: msg => this.#terminal.runInTerminal(msg),
  })
  #messages: MessagesPart = new MessagesPart(this, {
    reverse: () => this.#reverse,
    wire: () => this.#wire,
    out: () => this.#out,
    terminal: () => this.#terminal,
    lifetime: () => this.#lifetime,
    resolveInitialized: () => this.#resolveInitialized(),
    hostsDebuggee: () => {
      this.#hostsDebuggee = true
    },
    wakeStateWaiters: () => this.#wakeStateWaiters(),
  })
  #life: LifePart = new LifePart(this, {
    lifetime: () => this.#lifetime,
    terminal: () => this.#terminal,
    wire: () => this.#wire,
    child: () => this.#child,
    wakeStateWaiters: () => this.#wakeStateWaiters(),
    pushOutput: line => this.#pushOutput(line),
  })
  #frame = new FramePart(this)
  #initializedEvent: Promise<void>
  #resolveInitialized!: () => void
  #stateWaiters = new Set<() => void>()
  #start: StartPart = new StartPart(this, {
    rootStart: () => this.root().#start,
    initializedEvent: () => this.#initializedEvent,
    operationSignal: () => this.#operationSignal ?? this.root().#operationSignal,
    spec: () => this.#spec,
    cwd: () => this.#cwd,
    pushOutput: line => this.#pushOutput(line),
  })
  readonly children: DapSession[] = []
  readonly parentSession: DapSession | null
  readonly label: string
  readonly depth: number
  lastStoppedAt = 0
  lastStopped: StoppedInfo | null = null
  terminated = false
  exitDetail = ''
  capabilities: Record<string, unknown> | null = null
  startMode: 'launch' | 'attach' | null = null
  #hostsDebuggee = false
  output: string[] = []
  breakpoints = new Map<string, Array<{ line: number; verified: boolean; message?: string; id?: number }>>()
  functionBreakpoints: Array<{ name: string; verified: boolean; message?: string; id?: number }> = []

  constructor(
    adapterKey: string,
    spec: DapAdapterSpec,
    program: string,
    cwd: string,
    tcpPort?: number,
    wire: 'spawn' | 'dial' = 'spawn',
    treeInit?: { parent: DapSession | null; label: string },
    listener?: DapListenerTarget & { socket?: Socket },
  ) {
    super()
    this.adapterKey = adapterKey
    this.program = program
    this.#spec = spec
    this.#cwd = cwd
    this.#tcpPort = tcpPort
    this.parentSession = treeInit?.parent ?? null
    this.label = treeInit?.label ?? adapterKey
    this.depth = this.parentSession ? this.parentSession.depth + 1 : 0
    this.#initializedEvent = new Promise(res => {
      this.#resolveInitialized = res
    })
    if (this.parentSession) this.output = this.parentSession.root().output
    const transport = this.#life.openTransport(spec, cwd, tcpPort, wire, listener)
    this.#child = transport.child
    this.#listener = transport.listener
    this.#transportReady = transport.ready
  }

  #wakeStateWaiters(): void {
    for (const wake of [...this.#stateWaiters]) {
      try {
        wake()
      } catch (error) {
        passedOver(error)
      }
    }
    if (this.parentSession) this.parentSession.#wakeStateWaiters()
  }

  stoppedFrameId(): Promise<number | null> {
    return this.#frame.stoppedFrameId()
  }

  setBreakpointsTree(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    return this.#start.setBreakpointsTree(path, breakpoints)
  }

  setFunctionBreakpointsTree(
    specs: DapFunctionBreakpointSpec[],
  ): Promise<Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    return this.#start.setFunctionBreakpointsTree(specs)
  }

  treeTerminated(): boolean {
    return treeTerminated(this, this.#hostsDebuggee)
  }

  get listener(): DapListenerTarget | null {
    return this.#listener
  }

  get alive(): boolean {
    return !this.terminated && (this.#child === null || this.#child.exitCode === null)
  }

  #pushOutput(line: string): void {
    pushOutput(this, line)
  }

  flushPartialOutput(): void {
    this.#out.flushPartialOutput()
  }

  #createChildSession(configuration: Record<string, unknown>): DapSession {
    const label =
      typeof configuration.name === 'string' && configuration.name.length > 0
        ? configuration.name
        : `child-${this.root().treeSize()}`
    const program =
      typeof configuration.program === 'string' && configuration.program.length > 0
        ? configuration.program
        : this.program
    let child: DapSession
    if (this.#listener !== null) {
      child = new DapSession(this.adapterKey, this.#spec, program, this.#cwd, this.#listener.port, 'dial', { parent: this, label }, this.#listener)
    } else if (this.#spec.connect === 'tcp') {
      if (this.#tcpPort === undefined) throw new Error('tcp adapter session has no known server port')
      child = new DapSession(this.adapterKey, this.#spec, program, this.#cwd, this.#tcpPort, 'dial', {
        parent: this,
        label,
      })
    } else {
      child = new DapSession(this.adapterKey, this.#spec, program, this.#cwd, undefined, 'spawn', {
        parent: this,
        label,
      })
    }
    this.children.push(child)
    return child
  }

  terminalProcessCount(): number {
    return this.treeSessions().reduce((count, session) => count + session.#terminal.processes().size, 0)
  }

  async withOperation<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = this.#operationSignal
    this.#operationSignal = signal
    try {
      throwIfDapAborted(signal)
      return await run()
    } finally {
      this.#operationSignal = previous
    }
  }

  setTerminalRunner(runner: DapTerminalRunner): void {
    this.root().#terminal.setRunner(runner)
  }

  request(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal,
  ): Promise<Record<string, unknown>> {
    return this.#wire.request(command, args, timeoutMs, signal)
  }

  launch(options: DapStartOptions): Promise<void> {
    return this.#start.launch(options)
  }

  waitForStopOutcome(
    timeoutMs = 10_000,
    signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal,
    sinceStamp = 0,
  ): Promise<
    | { state: 'stopped'; info: StoppedInfo; session: DapSession }
    | { state: 'terminated' }
    | { state: 'timeout' }
    | { state: 'aborted' }
  > {
    return waitForStopOutcome(this, this.#stateWaiters, timeoutMs, signal, sinceStamp)
  }

  waitForStop(timeoutMs = 10_000, signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<StoppedInfo | null> {
    return waitForStop(this, timeoutMs, signal)
  }

  drainOutput(quietMs = 200, maxMs = 1_000, signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<void> {
    return drainOutput(this, quietMs, maxMs, signal)
  }

  dispose(signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<void> {
    return this.#life.dispose(signal)
  }

  killSync(): void {
    this.#life.killSync()
    this.#stateWaiters.clear()
  }

  _pendingRequestCountForTesting(): number {
    return this.#wire.pending().size
  }

  _stateWaiterCountForTesting(): number {
    return this.#stateWaiters.size
  }
}


const sessions = new Map<string, DapSession>()

function registryKey(owner: OwnerKey, id: string): string {
  return `${owner}::${id}`
}

function dapExecutionSpec(id: string, adapterKey: string) {
  return {
    id: `debug:${id}`,
    kind: 'debug-adapter' as const,
    label: `debug ${id} (${adapterKey})`,
    lifecycle: 'owner' as const,
    metadata: { alias: id, adapterKey },
  }
}

registerExecutionDomain('debug-adapter', {
  requestStop: record => {
    const alias = record.spec.metadata?.alias
    if (typeof alias !== 'string') return
    void removeDapSession(record.spec.owner, alias).catch(error => {
      logForDebugging(`dap: stop request for ${alias} failed: ${error instanceof Error ? error.message : String(error)}`)
      const key = registryKey(record.spec.owner, alias)
      const live = sessions.get(key)
      if (live) {
        sessions.delete(key)
        unregisterOwnerDisposer(record.spec.owner, `dap:${alias}`)
        try {
          live.killSync()
        } catch (killError) {
          passedOver(killError)
        }
      }
    })
  },
})

export function getDapSession(owner: OwnerKey, id: string): DapSession | undefined {
  return sessions.get(registryKey(owner, id))
}

export function listDapSessions(owner: OwnerKey): Array<{ id: string; session: DapSession }> {
  const prefix = `${owner}::`
  return [...sessions.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, session]) => ({ id: key.slice(prefix.length), session }))
}

export function liveDapSessionCount(): number {
  let n = 0
  for (const session of sessions.values()) if (session.alive) n++
  return n
}

export function _dapSessionCountForTesting(): number {
  return sessions.size
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export async function createDapSession(options: {
  owner: OwnerKey
  id: string
  adapterKey: string
  program: string
  args?: string[]
  runtimeArgs?: string[]
  launchExtras?: Record<string, unknown>
  env?: Record<string, string>
  module?: string
  cwd: string
  stopOnEntry?: boolean
  breakpoints?: Map<string, Array<number | DapBreakpointSpec>>
  mode?: 'launch' | 'attach'
  pid?: number
  port?: number
  host?: string
  noDebug?: boolean
  specOverride?: DapAdapterSpec
  signal?: AbortSignal
  terminalRunner?: DapTerminalRunner
}): Promise<DapSession> {
  throwIfDapAborted(options.signal)
  const resolved = options.specOverride ?? resolveAdapter(options.adapterKey)
  if (!resolved) {
    const dormant = dormantBuiltinAdapterHints()
    const envError = envAdapterTableError()
    throw new Error(
      (envError !== null ? `${envError} — ` : '') +
        `unknown adapter '${options.adapterKey}' — known: ${knownAdapterKeys().join(', ')}` +
        (dormant.length > 0
          ? `; dormant builtin lanes (install to arm): ${dormant.map(d => `${d.key} — ${d.hint}`).join(' · ')}`
          : '') +
        ` (extend via MERCURY_DAP_ADAPTERS or <configHome>/dap-adapters.json)`,
    )
  }
  const listener = listenerAttachTarget(resolved, options)
  const dial = listener !== null ? await dialListener(listener, REQUEST_TIMEOUT_MS, options.signal) : null
  if (dial !== null && 'refused' in dial) throw new Error(listenerRefusedLine(listener!, dial.refused, options.adapterKey))
  const dialed = dial !== null && 'socket' in dial ? dial.socket : null
  if (resolved.preflightError && dialed === null) {
    throw new Error(
      `adapter '${options.adapterKey}' is unavailable: ${resolved.preflightError}` +
        (resolved.installHint ? ` — ${resolved.installHint}` : ''),
    )
  }
  const tcpPort = resolved.connect === 'tcp' && dialed === null ? await pickFreePort() : undefined
  const spec: DapAdapterSpec = {
    ...resolved,
    args: resolved.args.flatMap(arg => {
      if (arg === '${args}') return options.args ?? []
      let out = arg
      if (tcpPort !== undefined) out = out.replaceAll('${port}', String(tcpPort))
      out = out.replaceAll('${program}', options.program)
      return [out]
    }),
  }
  const key = registryKey(options.owner, options.id)
  const existing = sessions.get(key)
  if (existing) {
    await existing.dispose(options.signal)
    projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'stopped', {
      outcome: { reason: 'replaced by a re-launch on the same alias' },
    })
  }
  if (options.signal?.aborted) {
    dialed?.destroy()
    throw new DapCancelledError()
  }
  const session =
    dialed !== null && listener !== null
      ? new DapSession(options.adapterKey, spec, options.program, options.cwd, listener.port, 'dial', { parent: null, label: options.id }, { ...listener, socket: dialed })
      : new DapSession(options.adapterKey, spec, options.program, options.cwd, tcpPort, 'spawn', {
          parent: null,
          label: options.id,
        })
  sessions.set(key, session)
  projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'starting')
  registerOwnerDisposer(options.owner, `dap:${options.id}`, async () => {
    const live = sessions.get(key)
    if (live) {
      sessions.delete(key)
      await live.dispose()
    }
  })
  try {
    if (options.terminalRunner) session.setTerminalRunner(options.terminalRunner)
    await session.withOperation(options.signal, () => session.launch({
      program: options.program,
      args: options.args,
      runtimeArgs: options.runtimeArgs,
      launchExtras: options.launchExtras,
      env: options.env,
      module: options.module,
      stopOnEntry: options.stopOnEntry,
      breakpoints: options.breakpoints,
      mode: options.mode,
      pid: options.pid,
      port: options.port,
      host: options.host,
      noDebug: options.noDebug,
    }))
  } catch (err) {
    const outputTail = session.output.slice(-6).join('\n')
    await session.dispose(options.signal)
    sessions.delete(key)
    unregisterOwnerDisposer(options.owner, `dap:${options.id}`)
    projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'failed', {
      outcome: { reason: `launch failed: ${(err as Error).message.slice(0, 120)}` },
    })
    const hint = spec.installHint ? ` (${spec.installHint})` : ''
    const tail = outputTail ? `\nadapter/debuggee output:\n${outputTail}` : ''
    throwIfDapAborted(options.signal)
    throw new Error(`${(err as Error).message}${hint}${tail}`)
  }
  projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'running')
  return session
}

export async function removeDapSession(owner: OwnerKey, id: string, signal?: AbortSignal): Promise<boolean> {
  const key = registryKey(owner, id)
  const session = sessions.get(key)
  if (!session) return false
  sessions.delete(key)
  unregisterOwnerDisposer(owner, `dap:${id}`)
  try {
    await session.dispose(signal)
  } finally {
    if (!session.terminated) {
      try {
        session.killSync()
      } catch (error) {
        passedOver(error)
      }
    }
    projectExternalState(owner, dapExecutionSpec(id, session.adapterKey), 'stopped', {
      outcome: { reason: 'session disconnected' },
    })
  }
  return true
}

process.on('exit', () => {
  for (const [, session] of sessions) {
    try {
      session.killSync()
    } catch (error) {
      passedOver(error)
    }
  }
  sessions.clear()
})
