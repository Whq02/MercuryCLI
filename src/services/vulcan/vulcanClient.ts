// ============================================================================
//  vulcanClient — Mercury's side of the VULCAN loopback protocol (NDJSON over
//  TCP to the mercury_vulcan editor addon).
//
//  Contract (proven by scripts/vulcan/prove-vulcan-protocol.ts):
//   · loopback ONLY by construction — the API takes a port, never a host.
//   · hello+token is the first frame; the server answers {ok:true,…} or an
//     error frame and drops. Handshake failures surface as AUTH_FAILED /
//     HANDSHAKE_CLOSED, never hangs.
//   · request/response correlation by integer id; per-request timeout
//     (default 30s) answers REQUEST_TIMEOUT with the op named.
//   · heartbeat: a ping every 10s while ready; a missed pong (5s) destroys
//     the connection (a wedged editor is a dead connection, not a hang).
//   · reconnect backoff: a failed connect arms a fast-fail window that
//     doubles 1s → 60s (reset on success); requests inside the window answer
//     EDITOR_UNREACHABLE immediately with the teaching hint. The next request
//     after the window reconnects automatically.
//   · unsolicited {event,data} frames buffer in a bounded ring (500) —
//     drainEvents() hands them to the tool layer.
//   · request() NEVER throws — every failure is {ok:false, error:{code,
//     message, hint}}.
// ============================================================================

import * as net from 'node:net'
import { findGodotProjectRoot, godotEditorHint } from '../lsp/godotLane.js'
import { vulcanEnabled, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { ensureVulcanToken } from './vulcanToken.js'

export interface VulcanError {
  code: string
  message: string
  hint?: string
}
export type VulcanResult = { ok: true; result: unknown } | { ok: false; error: VulcanError }
export interface VulcanEvent {
  event: string
  data: unknown
  at: number
}

const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 500
const HEARTBEAT_MS = 10_000
const PONG_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const BACKOFF_START_MS = 1_000
const BACKOFF_CAP_MS = 60_000
const CONNECT_TIMEOUT_MS = 3_000
const HELLO_TIMEOUT_MS = 5_000

function err(code: string, message: string, hint?: string): VulcanResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

interface Pending {
  resolve: (r: VulcanResult) => void
  timer: NodeJS.Timeout
  op: string
}

export class VulcanClient {
  private readonly port: number
  private readonly token: string
  private socket: net.Socket | null = null
  private state: 'disconnected' | 'connecting' | 'ready' = 'disconnected'
  private closed = false
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Requests issued while the handshake is in flight. */
  private queue: Array<{ op: string; args: Record<string, unknown> | undefined; timeoutMs: number; resolve: (r: VulcanResult) => void; queueTimer: NodeJS.Timeout | null }> = []
  /** the hello timer — cleared only when the HANDSHAKE
   *  FRAME settles, never on a raw data byte (a squatted port that keeps the
   *  socket open would otherwise defuse it and wedge 'connecting' forever). */
  private helloTimer: NodeJS.Timeout | null = null
  private events: VulcanEvent[] = []
  private heartbeat: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private backoffMs: number
  private backoffUntil = 0
  private helloError: VulcanError | null = null
  // Timing seams (proofs inject fast values; production uses the constants).
  private readonly heartbeatMs: number
  private readonly pongTimeoutMs: number
  private readonly backoffStartMs: number
  private readonly backoffCapMs: number
  private readonly connectTimeoutMs: number
  private readonly helloTimeoutMs: number

  constructor(opts: {
    port: number
    token: string
    heartbeatMs?: number
    pongTimeoutMs?: number
    backoffStartMs?: number
    backoffCapMs?: number
    connectTimeoutMs?: number
    helloTimeoutMs?: number
  }) {
    this.port = opts.port
    this.token = opts.token
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
    this.pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS
    this.backoffStartMs = opts.backoffStartMs ?? BACKOFF_START_MS
    this.backoffCapMs = opts.backoffCapMs ?? BACKOFF_CAP_MS
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    this.backoffMs = this.backoffStartMs
  }

  status(): 'disconnected' | 'connecting' | 'ready' {
    return this.state
  }

  /** The fast-fail window's remaining ms (0 = clear). Proof seam + hint text. */
  backoffRemainingMs(now: number = Date.now()): number {
    return Math.max(0, this.backoffUntil - now)
  }

  /** The delay the NEXT failed connect will arm. Proof seam. */
  nextDelayMs(): number {
    return this.backoffMs
  }

  drainEvents(): VulcanEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  async request(
    op: string,
    args?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<VulcanResult> {
    if (this.closed) return err('CLIENT_CLOSED', 'the VULCAN client was closed')
    if (this.state === 'ready') return this.send(op, args, timeoutMs)
    const remaining = this.backoffRemainingMs()
    if (remaining > 0) {
      return err(
        'EDITOR_UNREACHABLE',
        `the mercury_vulcan addon is not answering on 127.0.0.1:${this.port}`,
        `${godotEditorHint(this.port)}; addon installed + enabled? (vulcan_install) — retrying in ${Math.ceil(remaining / 1000)}s`,
      )
    }
    return new Promise<VulcanResult>(resolve => {
      // a request queued during 'connecting' carries its OWN deadline —
      // a handshake that never settles must not hang the caller (this file's
      // never-hangs contract).
      const entry = {
        op,
        args,
        timeoutMs,
        resolve,
        queueTimer: null as NodeJS.Timeout | null,
      }
      entry.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        resolve(
          err(
            'REQUEST_TIMEOUT',
            `${op} timed out after ${timeoutMs}ms waiting for the VULCAN connection`,
            `${godotEditorHint(this.port)}; op:"vulcan_status" to probe`,
          ),
        )
      }, timeoutMs)
      entry.queueTimer.unref?.()
      this.queue.push(entry)
      if (this.state === 'disconnected') this.connect()
    })
  }

  close(): void {
    this.closed = true
    this.teardown(err('CLIENT_CLOSED', 'the VULCAN client was closed'))
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  private connect(): void {
    this.state = 'connecting'
    this.helloError = null
    const socket = net.connect({ host: '127.0.0.1', port: this.port })
    this.socket = socket
    socket.setNoDelay(true)
    const connectTimer = setTimeout(() => socket.destroy(new Error('connect timeout')), this.connectTimeoutMs)
    connectTimer.unref?.()
    this.helloTimer = setTimeout(() => {
      if (this.state === 'connecting') socket.destroy(new Error('handshake timeout'))
    }, this.helloTimeoutMs)
    this.helloTimer.unref?.()

    socket.once('connect', () => {
      clearTimeout(connectTimer)
      socket.write(JSON.stringify({ op: 'hello', token: this.token, role: 'client', version: 1 }) + '\n')
    })
    // data does NOT clear the hello timer — only a parsed handshake
    // frame does (onFrame). A peer dribbling bytes without a frame dies at
    // the handshake deadline instead of wedging 'connecting' forever.
    socket.on('data', chunk => {
      this.onData(chunk.toString('utf8'))
    })
    const fail = () => {
      // error + close both fire for one failure — only the live socket's
      // FIRST event reaches onConnectionDown (else backoff doubles twice).
      if (this.socket !== socket) return
      clearTimeout(connectTimer)
      if (this.helloTimer) {
        clearTimeout(this.helloTimer)
        this.helloTimer = null
      }
      this.onConnectionDown()
    }
    socket.once('error', fail)
    socket.once('close', fail)
  }

  private onData(text: string): void {
    this.buf += text
    if (this.buf.length > MAX_LINE_BYTES) {
      this.socket?.destroy(new Error('oversized frame'))
      return
    }
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        if (this.state === 'connecting') {
          // an unparseable FIRST payload means the peer is not a
          // VULCAN server (a squatted port) — die now, bounded, instead of
          // resyncing forever on a stream that will never hand us a frame.
          this.socket?.destroy(new Error('unparseable handshake payload — not a VULCAN server?'))
          return
        }
        continue // one bad frame never kills the stream; the next line resyncs
      }
      this.onFrame(frame)
    }
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (this.state === 'connecting') {
      // The first frame answers the hello — THIS settles the hello timer
      //
      if (this.helloTimer) {
        clearTimeout(this.helloTimer)
        this.helloTimer = null
      }
      if (frame.ok === true) {
        this.state = 'ready'
        this.backoffMs = this.backoffStartMs
        this.backoffUntil = 0
        this.armHeartbeat()
        const queued = this.queue.splice(0)
        for (const q of queued) {
          if (q.queueTimer) clearTimeout(q.queueTimer)
          void this.send(q.op, q.args, q.timeoutMs).then(q.resolve)
        }
      } else {
        const e = (frame as { error?: VulcanError }).error
        this.helloError = e ?? { code: 'AUTH_FAILED', message: 'handshake refused' }
        // The server drops the socket next; onConnectionDown reports helloError.
      }
      return
    }
    if (typeof frame.id === 'number' && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.ok === true) p.resolve({ ok: true, result: (frame as { result?: unknown }).result })
      else {
        const e = (frame as { error?: VulcanError }).error
        p.resolve({
          ok: false,
          error: e ?? { code: 'BAD_FRAME', message: 'error frame without error body' },
        })
      }
      return
    }
    if (typeof frame.event === 'string') {
      this.events.push({ event: frame.event, data: (frame as { data?: unknown }).data, at: Date.now() })
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    }
  }

  private send(
    op: string,
    args: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<VulcanResult> {
    const socket = this.socket
    if (!socket || this.state !== 'ready') {
      return Promise.resolve(err('CONNECTION_LOST', `connection lost before ${op} was sent`))
    }
    const id = this.nextId++
    return new Promise<VulcanResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(
          err(
            'REQUEST_TIMEOUT',
            `${op} did not answer within ${timeoutMs}ms`,
            'the editor may be busy (import, long script); retry, or op:"vulcan_status" to probe',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer, op })
      socket.write(JSON.stringify({ id, op, ...(args && Object.keys(args).length ? { args } : {}) }) + '\n')
    })
  }

  private armHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => {
      const socket = this.socket
      if (!socket || this.state !== 'ready') return
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        socket.destroy(new Error('missed pong')) // → onConnectionDown
      }, this.pongTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: () => clearTimeout(timer), timer, op: 'ping' })
      socket.write(JSON.stringify({ id, op: 'ping' }) + '\n')
    }, this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.heartbeat = null
    this.pongTimer = null
  }

  private onConnectionDown(): void {
    if (this.closed) return
    const wasConnecting = this.state === 'connecting'
    const reason: VulcanResult = wasConnecting
      ? this.helloError
        ? { ok: false, error: this.helloError }
        : err(
            'HANDSHAKE_CLOSED',
            `could not establish the VULCAN handshake on 127.0.0.1:${this.port}`,
            `${godotEditorHint(this.port)}; addon installed + enabled? (vulcan_install)`,
          )
      : err('CONNECTION_LOST', 'the editor connection dropped mid-flight', 'retry — the client reconnects on the next call')
    this.teardown(reason)
    // Arm the fast-fail window (doubles to the cap; reset on the next hello-ok).
    this.backoffUntil = Date.now() + this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffCapMs)
  }

  private teardown(reason: VulcanResult): void {
    this.clearHeartbeat()
    const socket = this.socket
    this.socket = null
    this.state = 'disconnected'
    this.buf = ''
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(reason)
    }
    this.pending.clear()
    for (const q of this.queue.splice(0)) {
      if (q.queueTimer) clearTimeout(q.queueTimer)
      q.resolve(reason)
    }
  }
}

// ── the session singleton ────────────────────────────────────────────────────

let singleton: { client: VulcanClient; key: string } | null = null

/** The session client, or null when the surface is off / not a Godot project.
 *  Token side effect (file create) happens only here — armed paths only. */
export function getVulcanClient(): VulcanClient | null {
  if (!vulcanEnabled()) return null
  const root = findGodotProjectRoot()
  if (!root) return null
  const port = vulcanPort()
  const key = `${root}#${port}`
  if (singleton && singleton.key === key) return singleton.client
  singleton?.client.close()
  const client = new VulcanClient({ port, token: ensureVulcanToken(root) })
  singleton = { client, key }
  return client
}

export function resetVulcanClientForTest(): void {
  singleton?.client.close()
  singleton = null
}
