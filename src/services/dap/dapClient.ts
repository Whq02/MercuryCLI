
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DapCancelledError, dapDeadline, throwIfDapAborted, waitForDap } from './dapCancellation.js'
import type { DapTerminalRequest, DapTerminalRunner } from './dapTerminal.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
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
import { sleep } from '../../utils/sleep.js'
import { dormantBuiltinAdapterHints, knownAdapterKeys, resolveAdapter } from './client/adapters.js'
import { dialListener, listenerAttachTarget, listenerRefusedLine } from './client/listener.js'
import { adapterSilenceMessage } from './client/probes.js'
import {
  BREAKPOINT_REQUEST_TIMEOUT_MS,
  CLIENT_INIT_ARGS,
  OUTPUT_RING_MAX,
  REQUEST_TIMEOUT_MS,
  type DapAdapterSpec,
  type DapBreakpointSpec,
  type DapBreakpointVerdict,
  type DapDataAccessType,
  type DapDataBreakpointInfo,
  type DapDataBreakpointSpec,
  type DapFunctionBreakpointSpec,
  type DapInstructionBreakpointSpec,
  type DapListenerTarget,
  type DapWriteMemoryReceipt,
  type Pending,
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

const CHILD_SESSION_MAX_DEFAULT = 16
const CHILD_SESSION_DEPTH_MAX_DEFAULT = 4
let childSessionMax = CHILD_SESSION_MAX_DEFAULT
let childSessionDepthMax = CHILD_SESSION_DEPTH_MAX_DEFAULT

export function _setDapChildBoundsForTesting(
  maxChildren = CHILD_SESSION_MAX_DEFAULT,
  maxDepth = CHILD_SESSION_DEPTH_MAX_DEFAULT,
): void {
  childSessionMax = maxChildren
  childSessionDepthMax = maxDepth
}

let stopStamp = 0


export class DapSession {
  readonly adapterKey: string
  readonly program: string
  #spec: DapAdapterSpec
  #cwd: string
  #child: ChildProcessWithoutNullStreams | null
  #socket: Socket | null = null
  #tcpPort: number | undefined
  #listener: DapListenerTarget | null = null
  #transportReady: Promise<void>
  #seq = 1
  #pending = new Map<number, Pending>()
  #lifetime = new AbortController()
  #operationSignal: AbortSignal | undefined
  #terminalRunner: DapTerminalRunner | undefined
  #terminalProcesses = new Set<ChildProcess>()
  #terminalReaps = new Map<ChildProcess, Promise<void>>()
  terminalCleanup = { ended: 0, survivors: [] as number[] }
  #buffer = Buffer.alloc(0)
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
          ? this.#adoptSocket(listener.socket, `the program listening at ${listener.host}:${listener.port} closed the connection`)
          : this.#connectTcp(listener.port, listener.host)
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
      this.#transportReady = this.#connectTcp(tcpPort)
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
      this.#transportReady = this.#connectTcp(tcpPort)
    } else {
      child.stdout.on('data', (chunk: Buffer) => this.#onData(chunk))
      this.#transportReady = Promise.resolve()
    }
    child.stderr.on('data', (chunk: Buffer) => {
      this.#pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      if (!this.terminated) this.exitDetail = `adapter exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`
      this.terminated = true
      this.#lifetime.abort()
      void this.#reapTerminalProcesses()
      for (const [, p] of this.#pending) {
        p.cancelDeadline()
        p.reject(new Error(this.exitDetail))
      }
      this.#pending.clear()
      this.#wakeStateWaiters()
    })
    child.on('error', err => {
      this.terminated = true
      this.exitDetail = `adapter failed to start: ${err.message}`
      this.#lifetime.abort()
      void this.#reapTerminalProcesses()
      for (const [, p] of this.#pending) {
        p.cancelDeadline()
        p.reject(new Error(this.exitDetail))
      }
      this.#pending.clear()
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
    let best: DapSession | null = null
    for (const s of this.treeSessions()) {
      if (s.alive && s.lastStopped && s.lastStoppedAt > sinceStamp && (best === null || s.lastStoppedAt > best.lastStoppedAt)) {
        best = s
      }
    }
    return best
  }

  treeNewestStopStamp(): number {
    let max = 0
    for (const s of this.treeSessions()) {
      if (s.lastStoppedAt > max) max = s.lastStoppedAt
    }
    return max
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
    const out = new Map<string, Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>>()
    for (const s of this.treeSessions()) {
      for (const [path, rows] of s.breakpoints) {
        const cur = out.get(path)
        if (!cur) {
          out.set(
            path,
            rows.map(r => ({ ...r, ...(r.verified ? { verifier: s.label } : {}) })),
          )
          continue
        }
        rows.forEach((r, i) => {
          const prev = cur[i]
          if (!prev) cur[i] = { ...r, ...(r.verified ? { verifier: s.label } : {}) }
          else if (!prev.verified && r.verified) cur[i] = { ...r, verifier: s.label }
        })
      }
    }
    return out
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
    const out: Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }> = []
    for (const s of this.treeSessions()) {
      s.functionBreakpoints.forEach((r, i) => {
        const prev = out[i]
        if (!prev) out[i] = { ...r, ...(r.verified ? { verifier: s.label } : {}) }
        else if (!prev.verified && r.verified) out[i] = { ...r, verifier: s.label }
      })
    }
    return out
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
    const own = this.exitDetail.startsWith('debuggee exited') ? this.exitDetail : ''
    if (own !== '') return own
    for (const child of this.children) {
      const detail = child.treeExitDetail()
      if (detail !== '') return detail
    }
    return this.exitDetail
  }

  debuggeeEndDetail(): string {
    const tree = this.treeExitDetail()
    if (tree.startsWith('debuggee exited')) return tree
    for (let index = this.output.length - 1; index >= 0; index--) {
      const printed = /Process exited with code (\d+)/.exec(this.output[index] ?? '')
      if (printed !== null) return `debuggee exited (code ${printed[1]})`
    }
    return tree !== '' ? tree : 'debuggee ended (no non-zero exit code reported)'
  }

  debugTarget(): { session: DapSession } | { ambiguousDetail: string } {
    const stopped = this.treeStopped()
    if (stopped) return { session: stopped }
    const liveDescendants = this.treeSessions().filter(s => s !== this && s.alive)
    if (liveDescendants.length === 1) {
      const only = liveDescendants[0]
      if (only) return { session: only }
    }
    if (liveDescendants.length === 0) return { session: this }
    const listing = this.treeSessions()
      .map(
        s =>
          `${s.label}: ${s.terminated ? 'terminated' : s.lastStopped ? `stopped (${s.lastStopped.reason})` : 'running'}`,
      )
      .join(' · ')
    return {
      ambiguousDetail:
        `${liveDescendants.length} child sessions are live and none is stopped — refusing to guess a target. ` +
        `tree: ${listing}. Wait for a stop (op:"status" shows the tree), or op:"disconnect" to end the session`,
    }
  }

  async #connectTcp(port: number, host = '127.0.0.1', deadlineMs = 6_000): Promise<void> {
    const start = Date.now()
    for (;;) {
      if (this.terminated) throw new Error(this.exitDetail || 'adapter exited before the tcp port opened')
      const socket = await new Promise<Socket | null>(resolve => {
        const s = netConnect({ host, port }, () => resolve(s))
        s.on('error', () => resolve(null))
      })
      if (socket) {
        await this.#adoptSocket(socket, 'adapter socket closed')
        return
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`adapter never opened ${host}:${port} within ${deadlineMs}ms`)
      }
      await sleep(100)
    }
  }

  #adoptSocket(socket: Socket, closedDetail: string): Promise<void> {
    this.#socket = socket
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.on('close', () => {
      if (!this.terminated) {
        this.terminated = true
        this.exitDetail = this.exitDetail || closedDetail
        this.#lifetime.abort()
        void this.#reapTerminalProcesses()
        this.#wakeStateWaiters()
      }
      for (const [, p] of this.#pending) {
        p.cancelDeadline()
        p.reject(new Error(this.exitDetail))
      }
      this.#pending.clear()
    })
    socket.on('error', () => undefined)
    return Promise.resolve()
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

  #partialOutput = ''
  static readonly #PARTIAL_OUTPUT_KEEP_BYTES = 64 * 1024
  static readonly #RING_LINE_MAX_CHARS = 4_096
  #pushOutputChunk(chunk: string): void {
    this.#partialOutput += chunk
    for (;;) {
      const nl = this.#partialOutput.search(/[\r\n]/)
      if (nl === -1) break
      const line = this.#partialOutput.slice(0, nl).trimEnd()
      const next = this.#partialOutput[nl] === '\r' && this.#partialOutput[nl + 1] === '\n' ? nl + 2 : nl + 1
      this.#partialOutput = this.#partialOutput.slice(next)
      if (line) this.#pushOutput(line)
    }
    if (this.#partialOutput.length > DapSession.#PARTIAL_OUTPUT_KEEP_BYTES) {
      this.#partialOutput = this.#partialOutput.slice(-DapSession.#PARTIAL_OUTPUT_KEEP_BYTES)
    }
  }

  flushPartialOutput(): void {
    const rest = this.#partialOutput.trimEnd()
    this.#partialOutput = ''
    if (rest) this.#pushOutput(rest)
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.#buffer.subarray(0, headerEnd).toString('utf-8')
      const m = header.match(/Content-Length:\s*(\d+)/i)
      if (!m || m[1] === undefined) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(m[1])
      const start = headerEnd + 4
      if (this.#buffer.length < start + length) return
      const body = this.#buffer.subarray(start, start + length).toString('utf-8')
      this.#buffer = this.#buffer.subarray(start + length)
      try {
        this.#onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        logForDebugging(`dap: unparseable message body (${length} bytes)`)
      }
    }
  }

  #onMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'request') {
      this.#onReverseRequest(msg)
      return
    }
    if (msg.type === 'response') {
      const reqSeq = Number(msg.request_seq)
      const pending = this.#pending.get(reqSeq)
      if (!pending) return
      this.#pending.delete(reqSeq)
      pending.cancelDeadline()
      if (msg.success) {
        pending.resolve((msg.body as Record<string, unknown>) ?? {})
      } else {
        pending.reject(
          new Error(
            `${pending.command} failed: ${String(msg.message ?? 'unknown adapter error')}`,
          ),
        )
      }
      return
    }
    if (msg.type === 'event') {
      const body = (msg.body as Record<string, unknown>) ?? {}
      switch (msg.event) {
        case 'initialized':
          this.#resolveInitialized()
          break
        case 'process':
        case 'thread':
          this.#hostsDebuggee = true
          break
        case 'stopped':
          this.#hostsDebuggee = true
          this.lastStopped = {
            reason: String(body.reason ?? 'unknown'),
            threadId: typeof body.threadId === 'number' ? body.threadId : undefined,
            description:
              typeof body.description === 'string' ? body.description : undefined,
          }
          this.lastStoppedAt = ++stopStamp
          this.#wakeStateWaiters()
          break
        case 'continued':
          this.lastStopped = null
          break
        case 'output': {
          if (body.category === 'telemetry') break
          this.#pushOutputChunk(String(body.output ?? ''))
          break
        }
        case 'breakpoint': {
          const bp =
            (body.breakpoint as { id?: number; line?: number; verified?: boolean; message?: string } | undefined) ?? {}
          for (const rows of this.breakpoints.values()) {
            for (const row of rows) {
              const idMatch = typeof bp.id === 'number' && row.id === bp.id
              const lineMatch = typeof bp.id !== 'number' && typeof bp.line === 'number' && row.line === bp.line
              if (idMatch || lineMatch) {
                if (bp.verified === true) row.verified = true
                if (typeof bp.line === 'number') row.line = bp.line
                if (typeof bp.message === 'string') row.message = bp.message
              }
            }
          }
          for (const row of this.functionBreakpoints) {
            if (typeof bp.id === 'number' && row.id === bp.id) {
              if (bp.verified === true) row.verified = true
              if (typeof bp.message === 'string') row.message = bp.message
            }
          }
          break
        }
        case 'terminated':
        case 'exited':
          this.terminated = true
          this.#lifetime.abort()
          void this.#reapTerminalProcesses()
          this.flushPartialOutput()
          if (msg.event === 'exited') {
            this.exitDetail = `debuggee exited (code ${String(body.exitCode ?? '?')})`
          }
          this.#wakeStateWaiters()
          break
        default:
          break
      }
    }
  }

  #writeFrame(payload: string, onError?: (err: Error) => void, isCurrent: () => boolean = () => true): void {
    const framed = `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`
    void this.#transportReady
      .then(() => {
        if (!isCurrent()) return
        const wire = this.#socket ?? this.#child?.stdin
        if (!wire) throw new Error(this.exitDetail || 'session has no transport')
        wire.write(framed, err => {
          if (err) onError?.(err)
        })
      })
      .catch(err => onError?.(err as Error))
  }

  #respondToReverse(request: Record<string, unknown>, success: boolean, message?: string, body: Record<string, unknown> = {}): void {
    const payload = JSON.stringify({
      seq: this.#seq++,
      type: 'response',
      request_seq: Number(request.seq),
      command: String(request.command ?? ''),
      success,
      ...(message !== undefined ? { message } : {}),
      body,
    })
    this.#writeFrame(payload)
  }

  #childBoundRefusal(): string | null {
    if (this.root().treeSize() - 1 >= childSessionMax) {
      return `child-session bound reached (${childSessionMax} per tree) — op:"disconnect" and re-launch to reset`
    }
    if (this.depth + 1 > childSessionDepthMax) {
      return `child-session depth bound reached (${childSessionDepthMax}) — refusing a deeper session`
    }
    return null
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
    return this.treeSessions().reduce((count, session) => count + session.#terminalProcesses.size, 0)
  }

  #reapTerminalProcess(child: ChildProcess): Promise<void> {
    const pending = this.#terminalReaps.get(child)
    if (pending) return pending
    const reaped = (async () => {
      let receipt = await endProcessTree(child, 'SIGKILL')
      this.terminalCleanup.ended += receipt.ended
      if (receipt.survivors.length > 0 && child.pid !== undefined) {
        receipt = await endProcessTreeSurvivors(child.pid, receipt.survivors, 'SIGKILL')
        this.terminalCleanup.ended += receipt.ended
      }
      this.terminalCleanup.survivors.push(...receipt.survivors)
      if (receipt.survivors.length) this.#pushOutput(`[dap] debuggee cleanup could not end process(es): ${receipt.survivors.join(', ')}`)
      this.#terminalProcesses.delete(child)
      this.#terminalReaps.delete(child)
    })()
    this.#terminalReaps.set(child, reaped)
    return reaped
  }

  async #reapTerminalProcesses(): Promise<void> {
    await Promise.all([...this.#terminalProcesses].map(child => this.#reapTerminalProcess(child)))
  }

  async #runInTerminal(msg: Record<string, unknown>): Promise<number> {
    const args = (msg.arguments ?? {}) as Record<string, unknown>
    if (!Array.isArray(args.args) || args.args.length === 0 || !args.args.every(arg => typeof arg === 'string')) {
      throw new Error('runInTerminal needs a nonempty command argv of strings')
    }
    if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new Error('runInTerminal cwd must be a string')
    if (args.env !== undefined && (args.env === null || typeof args.env !== 'object' || Array.isArray(args.env) || !Object.values(args.env).every(value => value === null || typeof value === 'string'))) {
      throw new Error('runInTerminal env values must be strings or null')
    }
    const request: DapTerminalRequest = {
      args: args.args,
      cwd: path.resolve(this.#cwd, typeof args.cwd === 'string' ? args.cwd : '.'),
      ...(args.env !== undefined ? { env: args.env as Record<string, string | null> } : {}),
    }
    const runner = this.root().#terminalRunner
    if (!runner) throw new Error('runInTerminal requires the session’s Bash permission context')
    const combined = createCombinedAbortSignal(this.#operationSignal ?? this.root().#operationSignal, { signalB: this.#lifetime.signal })
    const started: ChildProcess[] = []
    let partial = ''
    const output = (chunk: string): void => {
      const lines = (partial + chunk).split(/\r\n|\r|\n/)
      partial = (lines.pop() ?? '').slice(-DapSession.#PARTIAL_OUTPUT_KEEP_BYTES)
      for (const line of lines) this.#pushOutput(`[debuggee] ${line.slice(0, DapSession.#RING_LINE_MAX_CHARS)}`)
    }
    try {
      throwIfDapAborted(combined.signal)
      const processId = await runner(request, combined.signal, child => {
        this.#terminalProcesses.add(child)
        started.push(child)
        this.#hostsDebuggee = true
        child.once('exit', () => { void this.#reapTerminalProcess(child) })
        child.once('close', () => { if (partial) { this.#pushOutput(`[debuggee] ${partial.slice(0, DapSession.#RING_LINE_MAX_CHARS)}`); partial = '' } })
      }, output)
      throwIfDapAborted(combined.signal)
      return processId
    } catch (error) {
      await Promise.all(started.map(child => this.#reapTerminalProcess(child)))
      throw error
    } finally {
      combined.cleanup()
    }
  }

  #onReverseRequest(msg: Record<string, unknown>): void {
    const command = String(msg.command ?? '')
    if (command === 'startDebugging') {
      const args = (msg.arguments as Record<string, unknown> | undefined) ?? {}
      const configuration = (args.configuration as Record<string, unknown> | undefined) ?? {}
      const requestKind: 'launch' | 'attach' = args.request === 'attach' ? 'attach' : 'launch'
      const refusal = this.#childBoundRefusal()
      if (refusal) {
        this.#respondToReverse(msg, false, refusal)
        this.#pushOutput(`[dap] refused startDebugging: ${refusal}`)
        return
      }
      let child: DapSession
      try {
        child = this.#createChildSession(configuration)
      } catch (e) {
        const reason = `child session could not start: ${(e as Error).message}`
        this.#respondToReverse(msg, false, reason)
        this.#pushOutput(`[dap] ${reason}`)
        return
      }
      this.#respondToReverse(msg, true)
      void child.withOperation(this.#operationSignal ?? this.root().#operationSignal, () => child.#runChildDance(requestKind, configuration)).catch(err => {
        this.#pushOutput(
          `[dap] child session '${child.label}' failed to start: ${(err as Error).message}`,
        )
        child.killSync()
      })
      return
    }
    if (command === 'runInTerminal') {
      void this.#runInTerminal(msg).then(
        processId => this.#respondToReverse(msg, true, undefined, { processId }),
        error => {
          const reason = error instanceof Error ? error.message : String(error)
          this.#respondToReverse(msg, false, reason)
          this.#pushOutput(`[dap] runInTerminal: ${reason}`)
        },
      )
      return
    }
    this.#respondToReverse(msg, false, `unsupported reverse request '${command}'`)
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
    this.root().#terminalRunner = runner
  }

  request(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(new DapCancelledError())
    if (!this.alive && command !== 'disconnect') {
      return Promise.reject(new Error(this.exitDetail || 'session is not alive'))
    }
    const seq = this.#seq++
    const payload = JSON.stringify({ seq, type: 'request', command, arguments: args ?? {} })
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.#pending.delete(seq)
        cancelDeadline()
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const onAbort = (): void => fail(new DapCancelledError())
      const cancelDeadline = dapDeadline(() => fail(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs)
      this.#pending.set(seq, { resolve: body => { cleanup(); resolve(body) }, reject: fail, cancelDeadline, command })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#writeFrame(payload, fail, () => this.#pending.has(seq))
    })
  }

  async launch(options: {
    program: string
    args?: string[]
    runtimeArgs?: string[]
    launchExtras?: Record<string, unknown>
    env?: Record<string, string>
    module?: string
    stopOnEntry?: boolean
    breakpoints?: Map<string, Array<number | DapBreakpointSpec>>
    mode?: 'launch' | 'attach'
    pid?: number
    port?: number
    host?: string
    noDebug?: boolean
  }): Promise<void> {
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
    let startBody: Record<string, unknown>
    if (attach) {
      const host = options.host ?? '127.0.0.1'
      if (this.#spec.buildAttachArgs) {
        startBody = this.#spec.buildAttachArgs({
          program: options.program,
          cwd: this.#cwd,
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...(options.port !== undefined ? { port: options.port } : {}),
          ...(options.pid !== undefined ? { pid: options.pid } : {}),
        })
      } else if (this.#spec.attachShape === 'connect' && options.port !== undefined) {
        startBody = { ...(this.#spec.attachDefaults ?? {}), connect: { host, port: options.port } }
      } else {
        startBody = {
          ...(this.#spec.attachDefaults ?? {}),
          ...(options.pid !== undefined ? { pid: options.pid } : {}),
          ...(options.port !== undefined ? { port: options.port, host } : {}),
          ...(options.program && options.pid === undefined && options.port === undefined
            ? { program: options.program }
            : {}),
        }
      }
    } else {
      startBody = this.#spec.buildLaunchArgs?.({
        program: options.program,
        args: options.args,
        cwd: this.#cwd,
        stopOnEntry: options.stopOnEntry,
      }) ?? {
        ...(this.#spec.launchDefaults ?? {}),
        ...(options.launchExtras ?? {}),
        ...(options.module !== undefined ? { module: options.module } : { program: options.program }),
        args: options.args ?? [],
        ...(options.runtimeArgs !== undefined ? { runtimeArgs: options.runtimeArgs } : {}),
        ...(options.env !== undefined
          ? { env: this.#spec.envShape === 'pairs' ? Object.entries(options.env).map(([key, value]) => `${key}=${value}`) : options.env }
          : {}),
        cwd: this.#cwd,
        stopOnEntry: options.stopOnEntry ?? false,
        noDebug: options.noDebug ?? false,
        console: 'internalConsole',
      }
    }
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

  async setBreakpoints(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number }>> {
    const specs: DapBreakpointSpec[] = breakpoints.map(b =>
      typeof b === 'number' ? { line: b } : b,
    )
    const body = await this.request(
      'setBreakpoints',
      {
        source: { path },
        breakpoints: specs.map(s => ({
          line: s.line,
          ...(s.column !== undefined ? { column: s.column } : {}),
          ...(s.condition !== undefined ? { condition: s.condition } : {}),
          ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
          ...(s.logMessage !== undefined ? { logMessage: s.logMessage } : {}),
        })),
        sourceModified: false,
      },
      BREAKPOINT_REQUEST_TIMEOUT_MS,
    )
    const reported = Array.isArray(body.breakpoints)
      ? (body.breakpoints as Array<{ verified?: boolean; line?: number; message?: string; id?: number }>)
      : []
    const verified = specs.map((s, i) => ({
      line: reported[i]?.line ?? s.line,
      verified: reported[i]?.verified === true,
      ...(typeof reported[i]?.id === 'number' ? { id: reported[i]?.id } : {}),
      ...(typeof reported[i]?.message === 'string' ? { message: reported[i]?.message } : {}),
    }))
    if (verified.length === 0) this.breakpoints.delete(path)
    else this.breakpoints.set(path, verified)
    return verified
  }

  async setFunctionBreakpoints(specs: DapFunctionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    const body = await this.request(
      'setFunctionBreakpoints',
      {
        breakpoints: specs.map(s => ({
          name: s.name,
          ...(s.condition !== undefined ? { condition: s.condition } : {}),
          ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
        })),
      },
      BREAKPOINT_REQUEST_TIMEOUT_MS,
    )
    const verdicts = this.#breakpointVerdicts(body, specs.length)
    this.functionBreakpoints = specs.map((s, i) => ({
      name: s.name,
      verified: verdicts[i]?.verified === true,
      ...(typeof verdicts[i]?.id === 'number' ? { id: verdicts[i]?.id } : {}),
      ...(typeof verdicts[i]?.message === 'string' ? { message: verdicts[i]?.message } : {}),
    }))
    return verdicts
  }

  #breakpointVerdicts(body: Record<string, unknown>, count: number): DapBreakpointVerdict[] {
    const reported = Array.isArray(body.breakpoints)
      ? (body.breakpoints as Array<{ verified?: boolean; message?: string; id?: number }>)
      : []
    return Array.from({ length: count }, (_, i) => ({
      verified: reported[i]?.verified === true,
      ...(typeof reported[i]?.id === 'number' ? { id: reported[i]?.id } : {}),
      ...(typeof reported[i]?.message === 'string' ? { message: reported[i]?.message } : {}),
    }))
  }

  async dataBreakpointInfo(args: {
    name: string
    variablesReference?: number
    frameId?: number
  }): Promise<DapDataBreakpointInfo> {
    const body = await this.request('dataBreakpointInfo', {
      name: args.name,
      ...(args.variablesReference !== undefined ? { variablesReference: args.variablesReference } : {}),
      ...(args.frameId !== undefined ? { frameId: args.frameId } : {}),
    })
    const accessTypes = Array.isArray(body.accessTypes)
      ? (body.accessTypes as unknown[]).filter(
          (t): t is DapDataAccessType => t === 'read' || t === 'write' || t === 'readWrite',
        )
      : undefined
    return {
      dataId: typeof body.dataId === 'string' && body.dataId.length > 0 ? body.dataId : null,
      description: typeof body.description === 'string' ? body.description : '',
      ...(accessTypes !== undefined ? { accessTypes } : {}),
      ...(typeof body.canPersist === 'boolean' ? { canPersist: body.canPersist } : {}),
    }
  }

  async setDataBreakpoints(specs: DapDataBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    const body = await this.request(
      'setDataBreakpoints',
      {
        breakpoints: specs.map(s => ({
          dataId: s.dataId,
          ...(s.accessType !== undefined ? { accessType: s.accessType } : {}),
          ...(s.condition !== undefined ? { condition: s.condition } : {}),
          ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
        })),
      },
      BREAKPOINT_REQUEST_TIMEOUT_MS,
    )
    return this.#breakpointVerdicts(body, specs.length)
  }

  async setInstructionBreakpoints(specs: DapInstructionBreakpointSpec[]): Promise<DapBreakpointVerdict[]> {
    const body = await this.request(
      'setInstructionBreakpoints',
      {
        breakpoints: specs.map(s => ({
          instructionReference: s.instructionReference,
          ...(s.offset !== undefined ? { offset: s.offset } : {}),
          ...(s.condition !== undefined ? { condition: s.condition } : {}),
          ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
        })),
      },
      BREAKPOINT_REQUEST_TIMEOUT_MS,
    )
    return this.#breakpointVerdicts(body, specs.length)
  }

  async writeMemory(args: {
    memoryReference: string
    data: string
    offset?: number
    allowPartial?: boolean
  }): Promise<DapWriteMemoryReceipt> {
    const body = await this.request('writeMemory', {
      memoryReference: args.memoryReference,
      data: args.data,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.allowPartial !== undefined ? { allowPartial: args.allowPartial } : {}),
    })
    return {
      ...(typeof body.offset === 'number' ? { offset: body.offset } : {}),
      ...(typeof body.bytesWritten === 'number' ? { bytesWritten: body.bytesWritten } : {}),
    }
  }

  async waitForStopOutcome(
    timeoutMs = 10_000,
    signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal,
    sinceStamp = 0,
  ): Promise<
    | { state: 'stopped'; info: StoppedInfo; session: DapSession }
    | { state: 'terminated' }
    | { state: 'timeout' }
    | { state: 'aborted' }
  > {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (signal?.aborted) return { state: 'aborted' }
      const stopped = this.treeStopped(sinceStamp)
      if (stopped?.lastStopped) {
        return { state: 'stopped', info: stopped.lastStopped, session: stopped }
      }
      if (this.treeTerminated()) return { state: 'terminated' }
      if (Date.now() >= deadline) return { state: 'timeout' }
      const woke = await new Promise<'event' | 'timeout' | 'aborted'>(resolve => {
        const cancelDeadline = dapDeadline(() => {
          cleanup()
          resolve('timeout')
        }, Math.max(0, deadline - Date.now()))
        const wake = (): void => {
          cleanup()
          resolve('event')
        }
        const onAbort = (): void => {
          cleanup()
          resolve('aborted')
        }
        const cleanup = (): void => {
          cancelDeadline()
          this.#stateWaiters.delete(wake)
          signal?.removeEventListener('abort', onAbort)
        }
        this.#stateWaiters.add(wake)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      if (woke === 'timeout') return { state: 'timeout' }
      if (woke === 'aborted') return { state: 'aborted' }
    }
  }

  async waitForStop(timeoutMs = 10_000, signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<StoppedInfo | null> {
    const outcome = await this.waitForStopOutcome(timeoutMs, signal)
    if (outcome.state === 'aborted') throw new DapCancelledError()
    return outcome.state === 'stopped' ? outcome.info : null
  }

  async drainOutput(quietMs = 200, maxMs = 1_000, signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<void> {
    const start = Date.now()
    let lastLen = this.output.length
    let lastChange = Date.now()
    for (;;) {
      if (Date.now() - start >= maxMs) break
      await waitForDap(sleep(50), signal)
      if (this.output.length !== lastLen) {
        lastLen = this.output.length
        lastChange = Date.now()
      } else if (Date.now() - lastChange >= quietMs) {
        break
      }
    }
    this.flushPartialOutput()
  }

  disconnectArguments(): Record<string, unknown> {
    if (this.capabilities?.supportTerminateDebuggee !== true) return {}
    return { terminateDebuggee: this.startMode !== 'attach' }
  }

  async dispose(signal: AbortSignal | undefined = this.#operationSignal ?? this.root().#operationSignal): Promise<void> {
    this.#lifetime.abort()
    await this.#reapTerminalProcesses()
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
    for (const process of this.#terminalProcesses) {
      strikeProcessGroupNow(process, 'SIGKILL')
      process.kill('SIGKILL')
    }
    this.#terminalProcesses.clear()
    for (const child of [...this.children]) {
      try {
        child.killSync()
      } catch {
      }
    }
    try {
      this.#socket?.destroy()
    } catch {
    }
    if (this.#child && this.#child.exitCode === null) this.#child.kill('SIGKILL')
    this.terminated = true
    for (const [, p] of this.#pending) {
      p.cancelDeadline()
      p.reject(new Error('session disposed'))
    }
    this.#pending.clear()
    this.#wakeStateWaiters()
    this.#stateWaiters.clear()
  }

  _pendingRequestCountForTesting(): number {
    return this.#pending.size
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
