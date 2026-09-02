// ============================================================================
//  services/eval/procKernel — one kernel child process, wrapped.
//
//  Owns exactly: spawn with the filtered env + fd-3 protocol pipe, the
//  handshake, one-cell-at-a-time execution with frame routing, interrupt/
//  kill escalation, and exit observation. Policy (keying, budgets, retry,
//  journal) lives in kernelManager; bridge semantics live in evalBridge.
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  encodeHostFrame,
  RunnerFrameDecoder,
  type BridgeRequestFrame,
  type RunnerFrame,
} from './protocol.js'
import { EVAL_SHUTDOWN_GRACE_MS } from './contracts.js'
import { logForDebugging } from '../../utils/debug.js'

export interface KernelSpawnSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface CellFrameHandlers {
  onStdout: (chunk: string) => void
  onStderr: (chunk: string) => void
  onDisplay: (frame: Extract<RunnerFrame, { t: 'display' }>) => void
  onResult: (repr: string) => void
  onError: (error: { name: string; value: string; traceback: string }) => void
  onBridge: (frame: BridgeRequestFrame) => void
}

export type CellEnd =
  | { kind: 'done'; status: 'ok' | 'error' | 'cancelled' }
  | { kind: 'kernel-exit'; code: number | null; signal: string | null }

type DataStream = 'stdout' | 'stderr'

/** The end mark the runner writes to fd 1 AND fd 2 after its own flush and
 *  ahead of the `done` frame. The two data pipes and the fd-3 protocol pipe
 *  are three kernel pipes with no ordering between them, so a `done` frame
 *  can overtake the cell's last stdout bytes on the host side; the cell
 *  settles only once both marks have arrived (or the kernel exits). The mark
 *  carries the cell id and the hello token, so user output can never spell
 *  it by accident. */
export function cellEndMark(cellId: string, token: string): string {
  return `\x1fmercury-eval-end ${cellId} ${token}\x1f`
}

/** A cell whose code closed or redirected fd 1/2 never writes its marks: the
 *  `done` frame settles it after this grace, with whatever bytes arrived. */
const END_MARK_GRACE_MS = 1500

export class ProcKernel {
  readonly token: string
  readonly startedAt = Date.now()
  private child: ChildProcess
  private decoder: RunnerFrameDecoder
  private currentCellId: string | null = null
  private handlers: CellFrameHandlers | null = null
  private cellEnd: ((end: CellEnd) => void) | null = null
  private exited: { code: number | null; signal: string | null } | null = null
  private exitWaiters: Array<() => void> = []
  /** Per-stream tail held back while it could be the head of a split mark. */
  private held: Record<DataStream, string> = { stdout: '', stderr: '' }
  private marked: Record<DataStream, boolean> = { stdout: false, stderr: false }
  private pendingDone: Extract<CellEnd, { kind: 'done' }> | null = null
  private settleTimer: NodeJS.Timeout | null = null
  executionCount = 0

  constructor(spec: KernelSpawnSpec) {
    this.token = randomBytes(16).toString('hex')
    this.decoder = new RunnerFrameDecoder(this.token)
    this.child = spawn(spec.command, spec.args, {
      windowsHide: true,
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: false,
    })
    this.child.stdout?.setEncoding('utf8')
    this.child.stderr?.setEncoding('utf8')
    const protoStream = this.child.stdio[3] as NodeJS.ReadableStream | null
    protoStream?.setEncoding?.('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData('stdout', chunk))
    this.child.stderr?.on('data', (chunk: string) => this.onData('stderr', chunk))
    protoStream?.on('data', (chunk: string | Buffer) => {
      for (const frame of this.decoder.push(String(chunk))) this.route(frame)
    })
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal: signal ?? null }
      // A `done` still waiting on its marks settles as done — the cell
      // finished; the exit came after it.
      if (this.pendingDone) this.settle()
      this.flushHeld()
      const end = this.cellEnd
      this.cellEnd = null
      this.currentCellId = null
      end?.({ kind: 'kernel-exit', code, signal: signal ?? null })
      for (const waiter of this.exitWaiters.splice(0)) waiter()
    })
    this.child.on('error', error => {
      logForDebugging(`eval kernel spawn error: ${String(error)}`)
      if (!this.exited) {
        this.exited = { code: null, signal: null }
        if (this.pendingDone) this.settle()
        this.flushHeld()
        const end = this.cellEnd
        this.cellEnd = null
        end?.({ kind: 'kernel-exit', code: null, signal: null })
        for (const waiter of this.exitWaiters.splice(0)) waiter()
      }
    })
  }

  /** Data from fd 1/2: user bytes flow to the cell's handler; the end mark
   *  is stripped and counted; a tail that could be the head of a split mark
   *  is held until the next chunk (or the cell's settle) decides it. */
  private onData(which: DataStream, chunk: string): void {
    const cellId = this.currentCellId
    if (cellId === null) return
    const mark = cellEndMark(cellId, this.token)
    let text = this.held[which] + chunk
    this.held[which] = ''
    const at = text.indexOf(mark)
    if (at !== -1) {
      const before = text.slice(0, at)
      const after = text.slice(at + mark.length)
      if (before) this.deliver(which, before)
      if (after) this.deliver(which, after)
      this.marked[which] = true
      this.maybeSettle()
      return
    }
    let keep = 0
    for (let k = Math.min(mark.length - 1, text.length); k > 0; k--) {
      if (mark.startsWith(text.slice(text.length - k))) {
        keep = k
        break
      }
    }
    if (keep > 0) {
      this.held[which] = text.slice(text.length - keep)
      text = text.slice(0, text.length - keep)
    }
    if (text) this.deliver(which, text)
  }

  private deliver(which: DataStream, text: string): void {
    const h = this.handlers
    if (!h) return
    if (which === 'stdout') h.onStdout(text)
    else h.onStderr(text)
  }

  private flushHeld(): void {
    for (const which of ['stdout', 'stderr'] as const) {
      const tail = this.held[which]
      this.held[which] = ''
      if (tail) this.deliver(which, tail)
    }
  }

  private maybeSettle(): void {
    if (this.pendingDone && this.marked.stdout && this.marked.stderr) this.settle()
  }

  /** The cell's `done` lands: every user byte the runner wrote ahead of its
   *  marks has been delivered by construction. */
  private settle(): void {
    const end = this.pendingDone
    if (!end) return
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.pendingDone = null
    this.flushHeld()
    this.marked = { stdout: false, stderr: false }
    const resolve = this.cellEnd
    this.cellEnd = null
    this.currentCellId = null
    this.handlers = null
    resolve?.(end)
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return this.exited === null && this.child.pid !== undefined
  }

  private route(frame: RunnerFrame): void {
    switch (frame.t) {
      case 'ready':
        this.readyResolve?.()
        return
      case 'started':
        return
      case 'display':
        if (frame.id === this.currentCellId) this.handlers?.onDisplay(frame)
        return
      case 'result':
        if (frame.id === this.currentCellId) this.handlers?.onResult(frame.repr)
        return
      case 'error':
        if (frame.id === this.currentCellId) {
          this.handlers?.onError({ name: frame.name, value: frame.value, traceback: frame.traceback })
        }
        return
      case 'bridge':
        // Bridge requests are only served for the RUNNING cell — a stray
        // background thread from a finished cell gets a refusal upstream.
        if (frame.id === this.currentCellId) this.handlers?.onBridge(frame)
        return
      case 'done': {
        if (frame.id !== this.currentCellId) return
        this.pendingDone = { kind: 'done', status: frame.status }
        this.maybeSettle()
        if (this.pendingDone) {
          this.settleTimer = setTimeout(() => this.settle(), END_MARK_GRACE_MS)
          this.settleTimer.unref?.()
        }
        return
      }
    }
  }

  private readyResolve: (() => void) | null = null

  /** Send hello and await the runner's ready (bounded). */
  async handshake(cwd: string, timeoutMs = 15_000): Promise<boolean> {
    const ready = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.readyResolve = null
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.readyResolve = () => {
        clearTimeout(timer)
        this.readyResolve = null
        resolve(true)
      }
    })
    this.send({ t: 'hello', token: this.token, cwd })
    const exitRace = new Promise<boolean>(resolve => {
      this.onExit(() => resolve(false))
    })
    return Promise.race([ready, exitRace])
  }

  private send(frame: Parameters<typeof encodeHostFrame>[0]): void {
    try {
      this.child.stdin?.write(encodeHostFrame(frame))
    } catch (error) {
      logForDebugging(`eval kernel stdin write failed: ${String(error)}`)
    }
  }

  answerBridge(bridgeId: string, ok: boolean, value?: unknown, error?: string): void {
    this.send({ t: 'bridge_result', bridgeId, ok, ...(ok ? { value } : { error }) })
  }

  /** Run one cell. Resolves with how the cell ENDED (done frame or kernel
   *  exit); stream/display/bridge traffic flows through the handlers while
   *  the cell runs. Exactly one cell may run at a time. */
  exec(cellId: string, code: string, handlers: CellFrameHandlers): Promise<CellEnd> {
    if (this.currentCellId !== null) {
      return Promise.resolve({ kind: 'done', status: 'error' }) // manager serializes; defensive
    }
    if (!this.alive) return Promise.resolve({ kind: 'kernel-exit', code: null, signal: null })
    this.executionCount += 1
    this.currentCellId = cellId
    this.handlers = handlers
    this.held = { stdout: '', stderr: '' }
    this.marked = { stdout: false, stderr: false }
    this.pendingDone = null
    return new Promise<CellEnd>(resolve => {
      this.cellEnd = resolve
      this.send({ t: 'exec', id: cellId, code, seq: this.executionCount })
    })
  }

  interrupt(): void {
    try {
      if (!this.alive || !this.child.pid) return
      if (process.platform === 'win32') {
        // No cross-process console interrupt exists on Windows (SIGINT via
        // process.kill is undeliverable): an interrupt that must stop the
        // work terminates the kernel — the cell fails with the loss named
        // through the ordinary kernel-death path, never a silent no-op.
        this.kill()
        return
      }
      const pid = this.child.pid
      const sigint: NodeJS.Signals = 'SIGINT'
      process.kill(pid, sigint)
    } catch {
      /* already gone */
    }
  }

  kill(): void {
    try {
      if (this.alive && this.child.pid) this.child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  onExit(callback: () => void): void {
    if (this.exited) {
      callback()
      return
    }
    this.exitWaiters.push(callback)
  }

  /** Polite shutdown escalation: bye → SIGTERM → SIGKILL on a grace budget. */
  async dispose(): Promise<void> {
    if (!this.alive) return
    this.send({ t: 'bye' })
    const exited = (): Promise<void> => (this.alive ? once(this.child, 'exit').then(() => undefined) : Promise.resolve())
    const grace = (ms: number): Promise<'timeout'> =>
      new Promise(resolve => {
        const t = setTimeout(() => resolve('timeout'), ms)
        t.unref?.()
      })
    if ((await Promise.race([exited(), grace(EVAL_SHUTDOWN_GRACE_MS)])) === 'timeout' && this.alive) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* gone */
      }
      if ((await Promise.race([exited(), grace(EVAL_SHUTDOWN_GRACE_MS)])) === 'timeout' && this.alive) {
        this.kill()
        await Promise.race([exited(), grace(1_000)])
      }
    }
  }
}
