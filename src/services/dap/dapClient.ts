
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DapCancelledError, throwIfDapAborted, waitForDap } from './dapCancellation.js'
import type { DapTerminalRunner } from './dapTerminal.js'
import { createServer as createNetServer, type Socket } from 'node:net'
import { pythonSpawnEnv } from './debugpyResolver.js'
import * as path from 'node:path'
import type { OwnerKey } from '../run/ownerKey.js'
import {
  registerOwnerDisposer,
  unregisterOwnerDisposer,
} from '../run/ownerLifecycle.js'
import { registerExecutionDomain } from '../primitives/executionPlane.js'
import { projectExternalState } from '../primitives/externalProjection.js'
import { logForDebugging } from '../../utils/debug.js'
import { endProcessTree, endProcessTreeSurvivors, strikeProcessGroupNow } from '../../utils/processGroup.js'
import { dormantBuiltinAdapterHints, knownAdapterKeys, resolveAdapter } from './client/adapters.js'
import { dialListener, listenerAttachTarget, listenerRefusedLine } from './client/listener.js'
import { adapterSilenceMessage } from './client/probes.js'
import {
  dataBreakpointInfo,
  setBreakpoints,
  setDataBreakpoints,
  setFunctionBreakpoints,
  setInstructionBreakpoints,
  writeMemory,
} from './client/breakpoints.js'
import { startBodyOf, type DapStartOptions } from './client/launch.js'
import { MessagesPart } from './client/messages.js'
import { OutputPart } from './client/output.js'
import { childBoundRefusal, ReversePart } from './client/reverse.js'
import { TerminalPart } from './client/terminal.js'
import { WirePart } from './client/wire.js'
import { drainOutput, waitForStopOutcome } from './client/stops.js'
import {
  debuggeeEndDetail,
  debugTarget,
  treeExitDetail,
  treeNewestStopStamp,
  treeStopped,
  treeVerifiedBreakpoints,
  treeVerifiedFunctionBreakpoints,
} from './client/tree.js'
import {
  CLIENT_INIT_ARGS,
  OUTPUT_RING_MAX,
  REQUEST_TIMEOUT_MS,
  type DapAdapterSpec,
  type DapBreakpointSpec,
  type DapBreakpointVerdict,
  type DapDataBreakpointInfo,
  type DapDataBreakpointSpec,
  type DapFunctionBreakpointSpec,
  type DapInstructionBreakpointSpec,
  type DapListenerTarget,
  type DapWriteMemoryReceipt,
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
  DapLaunchOptions,
  DapListenerDial,
  DapListenerTarget,
  DapWriteMemoryReceipt,
  StoppedInfo,
} from './client/shared.js'
export { dialListener, listenerAttachTarget, listenerRefusedLine } from './client/listener.js'
export { _setDapChildBoundsForTesting } from './client/reverse.js'
export {
  _resetDarwinDebuggerAuthForTesting,
  _resetGdbProbeForTesting,
  _resetLldbDapForTesting,
  adapterSilenceMessage,
  darwinDebuggerAuthorisationHint,
  ELIXIR_DEBUG_ADAPTER_BINARIES,
  ELIXIR_DEBUG_ADAPTER_HINT,
  gdbInstallHint,
  gdbProbeFromMemo,
  gdbProbePending,
  KOTLIN_DEBUG_ADAPTER_HINT,
  lldbDapFromMemo,
  lldbDapInstallHint,
  lldbDapProbePending,
  netcoredbgInstallHint,
  probeGdbDap,
  probeGdbDapAsync,
  probeLldbDapAsync,
  resolveLldbDap,
  type GdbProbe,
  type LldbDapResolution,
} from './client/probes.js'
export { jsDebugSourceLabel, resolveJsDebugServer, type JsDebugResolution } from './client/builtins.js'
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

export class DapSession {
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
    socketClosed: closedDetail => this.#socketClosed(closedDetail),
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
    runChildDance: (child, requestKind, configuration) => child.#runChildDance(requestKind, configuration),
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
  #initializedEvent: Promise<void>
  #resolveInitialized!: () => void
  #stateWaiters = new Set<() => void>()
  #requestedBreakpoints: Map<string, Array<number | DapBreakpointSpec>> | null = null
  #requestedFunctionBreakpoints: DapFunctionBreakpointSpec[] | null = null
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
    if (wire === 'dial' && listener !== undefined) {
      this.#child = null
      this.#listener = { host: listener.host, port: listener.port }
      this.#transportReady =
        listener.socket !== undefined
          ? this.#wire.adoptSocket(listener.socket, `the program listening at ${listener.host}:${listener.port} closed the connection`)
          : this.#wire.connectTcp(listener.port, listener.host)
      return
    }
    if (wire === 'dial') {
      this.#child = null
      if (tcpPort === undefined) {
        this.terminated = true
        this.exitDetail = 'dial session has no server port'
        this.#transportReady = Promise.reject(new Error(this.exitDetail))
        this.#transportReady.catch(() => {})
        return
      }
      this.#transportReady = this.#wire.connectTcp(tcpPort)
      return
    }
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: pythonSpawnEnv(),
    })
    this.#child = child
    child.stdin.on('error', err => logForDebugging(`dap: adapter stdin error: ${err.message}`))
    if (spec.connect === 'tcp' && tcpPort !== undefined) {
      child.stdout.on('data', (chunk: Buffer) => {
        this.#pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
      })
      this.#transportReady = this.#wire.connectTcp(tcpPort)
    } else {
      child.stdout.on('data', (chunk: Buffer) => this.#wire.onData(chunk))
      this.#transportReady = Promise.resolve()
    }
    child.stderr.on('data', (chunk: Buffer) => {
      this.#pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      if (!this.terminated) this.exitDetail = `adapter exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`
      this.terminated = true
      this.#lifetime.abort()
      void this.#terminal.reapTerminalProcesses()
      for (const [, p] of this.#wire.pending()) {
        p.cancelDeadline()
        p.reject(new Error(this.exitDetail))
      }
      this.#wire.pending().clear()
      this.#wakeStateWaiters()
    })
    child.on('error', err => {
      this.terminated = true
      this.exitDetail = `adapter failed to start: ${err.message}`
      this.#lifetime.abort()
      void this.#terminal.reapTerminalProcesses()
      for (const [, p] of this.#wire.pending()) {
        p.cancelDeadline()
        p.reject(new Error(this.exitDetail))
      }
      this.#wire.pending().clear()
      this.#wakeStateWaiters()
    })
  }

  #wakeStateWaiters(): void {
    for (const wake of [...this.#stateWaiters]) {
      try {
        wake()
      } catch {
      }
    }
    if (this.parentSession) this.parentSession.#wakeStateWaiters()
  }


  root(): DapSession {
    let s: DapSession = this
    while (s.parentSession) s = s.parentSession
    return s
  }

  treeSessions(): DapSession[] {
    const out: DapSession[] = [this]
    for (const child of this.children) out.push(...child.treeSessions())
    return out
  }

  treeSize(): number {
    return this.treeSessions().length
  }

  treeStopped(sinceStamp = 0): DapSession | null {
    return treeStopped(this, sinceStamp)
  }

  treeNewestStopStamp(): number {
    return treeNewestStopStamp(this)
  }

  #stoppedFrameMemo: { stamp: number; frameId: number } | null = null

  async stoppedFrameId(): Promise<number | null> {
    const stopped = this.lastStopped
    if (!stopped) return null
    const stamp = this.lastStoppedAt
    if (this.#stoppedFrameMemo?.stamp === stamp) return this.#stoppedFrameMemo.frameId
    let threadId = stopped.threadId
    if (threadId === undefined) {
      const body = await this.request('threads')
      const threads = Array.isArray(body.threads) ? (body.threads as Array<{ id?: number }>) : []
      threadId = threads[0]?.id
      if (threadId === undefined) return null
    }
    const body = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
    const frames = Array.isArray(body.stackFrames) ? (body.stackFrames as Array<{ id?: number }>) : []
    const frameId = frames[0]?.id
    if (typeof frameId !== 'number') return null
    if (this.lastStoppedAt === stamp) this.#stoppedFrameMemo = { stamp, frameId }
    return frameId
  }

  treeVerifiedBreakpoints(): Map<
    string,
    Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>
  > {
    return treeVerifiedBreakpoints(this)
  }

  async setBreakpointsTree(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    const root = this.root()
    const clearing = breakpoints.length === 0
    if (clearing) {
      root.#requestedBreakpoints?.delete(path)
    } else {
      if (!root.#requestedBreakpoints) root.#requestedBreakpoints = new Map()
      root.#requestedBreakpoints.set(path, breakpoints)
    }
    for (const s of root.treeSessions()) {
      if (!s.alive) {
        s.breakpoints.delete(path)
        continue
      }
      try {
        await s.setBreakpoints(path, breakpoints)
      } catch (err) {
        this.#pushOutput(`[dap] breakpoints for ${path} on '${s.label}' failed: ${(err as Error).message}`)
      }
    }
    return root.treeVerifiedBreakpoints().get(path) ?? []
  }

  acceptsFunctionBreakpoints(): boolean {
    return this.capabilities === null || this.capabilities.supportsFunctionBreakpoints === true
  }

  treeVerifiedFunctionBreakpoints(): Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }> {
    return treeVerifiedFunctionBreakpoints(this)
  }

  async setFunctionBreakpointsTree(
    specs: DapFunctionBreakpointSpec[],
  ): Promise<Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    const root = this.root()
    root.#requestedFunctionBreakpoints = specs.length > 0 ? specs : null
    for (const s of root.treeSessions()) {
      if (!s.alive) {
        s.functionBreakpoints = []
        continue
      }
      if (!s.acceptsFunctionBreakpoints()) continue
      try {
        await s.setFunctionBreakpoints(specs)
      } catch (err) {
        this.#pushOutput(`[dap] function breakpoints on '${s.label}' failed: ${(err as Error).message}`)
      }
    }
    return root.treeVerifiedFunctionBreakpoints()
  }

  treeTerminated(): boolean {
    if (this.terminated) return true
    if (this.#hostsDebuggee) return false
    return this.children.length > 0 && this.children.every(c => c.treeTerminated())
  }

  treeExitDetail(): string {
    return treeExitDetail(this)
  }

  debuggeeEndDetail(): string {
    return debuggeeEndDetail(this)
  }

  debugTarget(): { session: DapSession } | { ambiguousDetail: string } {
    return debugTarget(this)
  }

  #socketClosed(closedDetail: string): void {
    if (!this.terminated) {
      this.terminated = true
      this.exitDetail = this.exitDetail || closedDetail
      this.#lifetime.abort()
      void this.#terminal.reapTerminalProcesses()
      this.#wakeStateWaiters()
    }
  }

  get listener(): DapListenerTarget | null {
    return this.#listener
  }

  get alive(): boolean {
    return !this.terminated && (this.#child === null || this.#child.exitCode === null)
  }

  #pushOutput(line: string): void {
    this.output.push(line)
    if (this.output.length > OUTPUT_RING_MAX) {
      this.output.splice(0, this.output.length - OUTPUT_RING_MAX)
    }
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

  async #runChildDance(
    requestKind: 'launch' | 'attach',
    configuration: Record<string, unknown>,
  ): Promise<void> {
    this.startMode = requestKind
    this.capabilities = await this.request('initialize', {
      ...CLIENT_INIT_ARGS,
      adapterID: this.adapterKey,
    })
    const startDone = this.request(requestKind, configuration, 20_000)
    startDone.catch(() => {})
    const sawInitialized = await waitForDap(this.#initializedEvent.then(() => true), this.#operationSignal ?? this.root().#operationSignal, 10_000)
    if (!sawInitialized) {
      throw new Error(adapterSilenceMessage('child adapter never sent initialized (10s)', this.adapterKey))
    }
    const requested = this.root().#requestedBreakpoints
    if (requested) {
      for (const [path, lines] of requested) {
        await this.setBreakpoints(path, lines).catch(err =>
          this.#pushOutput(
            `[dap] child '${this.label}' breakpoints for ${path} failed: ${(err as Error).message}`,
          ),
        )
      }
    }
    const requestedFunctions = this.root().#requestedFunctionBreakpoints
    if (requestedFunctions && this.acceptsFunctionBreakpoints()) {
      await this.setFunctionBreakpoints(requestedFunctions).catch(err =>
        this.#pushOutput(`[dap] child '${this.label}' function breakpoints failed: ${(err as Error).message}`),
      )
    }
    await this.request('configurationDone').catch(() => {
    })
    await startDone
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

  async launch(options: DapStartOptions): Promise<void> {
    this.#requestedBreakpoints = options.breakpoints ?? null
    this.capabilities = await this.request('initialize', {
      ...CLIENT_INIT_ARGS,
      adapterID: this.adapterKey,
    }).catch((error: unknown) => {
      if (this.#listener === null || !(error instanceof Error) || !/timed out/.test(error.message)) throw error
      throw new Error(`the program listening at ${this.#listener.host}:${this.#listener.port} did not answer initialize within ${REQUEST_TIMEOUT_MS}ms — is it a debugpy --listen socket?`)
    })
    const attach = options.mode === 'attach' || this.#spec.startRequest === 'attach'
    this.startMode = attach ? 'attach' : 'launch'
    const startBody = startBodyOf(this.#spec, this.#cwd, options, attach)
    const launchDone = this.request(attach ? 'attach' : 'launch', startBody, 20_000)
    launchDone.catch(() => {})
    const initializedTimeoutMs = options.noDebug ? 2_000 : 10_000
    const sawInitialized = await waitForDap(this.#initializedEvent.then(() => true), this.#operationSignal ?? this.root().#operationSignal, initializedTimeoutMs)
    if (!sawInitialized && !options.noDebug) {
      if (this.#listener !== null) {
        throw new Error(`the program listening at ${this.#listener.host}:${this.#listener.port} never sent initialized (10s) — is it a debugpy --listen socket?`)
      }
      throw new Error(adapterSilenceMessage('adapter never sent initialized (10s)', this.adapterKey))
    }
    if (sawInitialized) {
      if (options.breakpoints && !options.noDebug) {
        for (const [path, lines] of options.breakpoints) {
          try {
            await this.setBreakpoints(path, lines)
          } catch (err) {
            this.#recordUnboundBreakpoints(path, lines, err)
          }
        }
      }
      await this.request('configurationDone').catch(() => {
      })
    }
    await launchDone
  }

  #recordUnboundBreakpoints(path: string, breakpoints: Array<number | DapBreakpointSpec>, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err)
    this.breakpoints.set(
      path,
      breakpoints.map(b => ({ line: typeof b === 'number' ? b : b.line, verified: false, message: `setBreakpoints failed: ${reason}` })),
    )
    this.#pushOutput(`[dap] breakpoints for ${path} on '${this.label}' failed: ${reason} — the program runs without them; op:"breakpoints" retries the binding`)
  }

  setBreakpoints(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number }>> {
    return setBreakpoints(this, path, breakpoints)
  }

  setFunctionBreakpoints(specs: DapFunctionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    return setFunctionBreakpoints(this, specs)
  }

  dataBreakpointInfo(args: {
    name: string
    variablesReference?: number
    frameId?: number
  }): Promise<DapDataBreakpointInfo> {
    return dataBreakpointInfo(this, args)
  }

  setDataBreakpoints(specs: DapDataBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    return setDataBreakpoints(this, specs)
  }

  setInstructionBreakpoints(specs: DapInstructionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    return setInstructionBreakpoints(this, specs)
  }

  writeMemory(args: {
    memoryReference: string
    data: string
    offset?: number
    allowPartial?: boolean
  }): Promise<DapWriteMemoryReceipt> {
    return writeMemory(this, args)
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

  async waitForStop(timeoutMs = 10_000, signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<StoppedInfo | null> {
    const outcome = await this.waitForStopOutcome(timeoutMs, signal)
    if (outcome.state === 'aborted') throw new DapCancelledError()
    return outcome.state === 'stopped' ? outcome.info : null
  }

  drainOutput(quietMs = 200, maxMs = 1_000, signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<void> {
    return drainOutput(this, quietMs, maxMs, signal)
  }

  disconnectArguments(): Record<string, unknown> {
    if (this.capabilities?.supportTerminateDebuggee !== true) return {}
    return { terminateDebuggee: this.startMode !== 'attach' }
  }

  async dispose(signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<void> {
    this.#lifetime.abort()
    await this.#terminal.reapTerminalProcesses()
    for (const child of [...this.children]) {
      await child.dispose(signal)
    }
    if (this.#listener === null || this.capabilities !== null) {
      try {
        await this.request('disconnect', this.disconnectArguments(), 2_000, signal)
      } catch {
      }
    }
    const child = this.#child
    if (child !== null && child.exitCode === null) {
      const receipt = await endProcessTree(child, 'SIGKILL')
      if (receipt.survivors.length > 0 && child.pid) {
        await endProcessTreeSurvivors(child.pid, receipt.survivors, 'SIGKILL')
      }
    }
    this.killSync()
  }

  killSync(): void {
    this.#lifetime.abort()
    for (const process of this.#terminal.processes()) {
      strikeProcessGroupNow(process, 'SIGKILL')
      process.kill('SIGKILL')
    }
    this.#terminal.processes().clear()
    for (const child of [...this.children]) {
      try {
        child.killSync()
      } catch {
      }
    }
    try {
      this.#wire.socket()?.destroy()
    } catch {
    }
    if (this.#child && this.#child.exitCode === null) this.#child.kill('SIGKILL')
    this.terminated = true
    for (const [, p] of this.#wire.pending()) {
      p.cancelDeadline()
      p.reject(new Error('session disposed'))
    }
    this.#wire.pending().clear()
    this.#wakeStateWaiters()
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
    void removeDapSession(record.spec.owner, alias).catch(() => {})
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
    throw new Error(
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
  await session.dispose(signal)
  projectExternalState(owner, dapExecutionSpec(id, session.adapterKey), 'stopped', {
    outcome: { reason: 'session disconnected' },
  })
  return true
}

process.on('exit', () => {
  for (const [, session] of sessions) {
    try {
      session.killSync()
    } catch {
    }
  }
  sessions.clear()
})
