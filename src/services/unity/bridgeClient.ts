// ============================================================================
//  bridgeClient — Mercury's side of the UNITY-BRIDGE loopback protocol
//  (NDJSON over TCP to the com.mercury.unity-bridge editor package; the wire
//  contract lives WHOLE in services/unity/bridgeProtocol.ts — this module
//  adds transport behavior only). The vulcanClient grammar, kept exactly:
//
//   · loopback ONLY by construction — the API takes a port, never a host.
//   · hello+token is the first frame; the server answers {ok:true,…} or an
//     error frame and drops. Handshake failures surface as AUTH_FAILED /
//     VERSION_SKEW / HANDSHAKE_CLOSED, never hangs.
//   · THE SKEW ARM (beyond the vulcan sibling): a hello answered ok but
//     carrying a foreign result.version refuses BRIDGE_VERSION_SKEW naming
//     both versions — no op is ever sent across a version gap.
//   · request/response correlation by integer id; per-request timeout
//     (default 30s) answers REQUEST_TIMEOUT with the op named.
//   · heartbeat: a ping every 10s while ready; a missed pong (5s) destroys
//     the connection (a wedged editor is a dead connection, not a hang).
//   · reconnect backoff: a failed connect arms a fast-fail window that
//     doubles 1s → 60s (reset on success); requests inside the window answer
//     EDITOR_UNREACHABLE immediately with the teaching hint. The next
//     request after the window reconnects automatically. A Unity DOMAIN
//     RELOAD (entering play mode, recompiles) drops the socket BY CONTRACT —
//     this posture is how the drop heals, not an error path.
//   · unsolicited {event,data} frames buffer in a bounded ring (500) —
//     drainEvents() hands them to the tool layer.
//   · request() NEVER throws — every failure is {ok:false, error:{code,
//     message, hint}}.
//
//  Proof: scripts/unity-bridge/prove-unity-bridge-protocol.ts against the
//  scripted fake bridge (scripts/unity-bridge/fake-bridge.ts).
// ============================================================================

import * as net from 'node:net'
import { findUnityProjectRoot } from '../ide/unityProject.js'
import { unityBridgeEnabled, unityBridgePort } from '../../utils/unity/bridgeGates.js'
import {
  UNITY_BRIDGE_MAX_LINE_BYTES,
  UNITY_BRIDGE_PROTOCOL_VERSION,
  buildUnityBridgeHelloFrame,
  buildUnityBridgeRequestFrame,
  parseUnityBridgeFrame,
  type UnityBridgeError,
  type UnityBridgeHelloInfo,
  type UnityBridgeResult,
} from './bridgeProtocol.js'
import { ensureUnityBridgeToken } from './bridgeToken.js'

export type { UnityBridgeError, UnityBridgeResult } from './bridgeProtocol.js'

export interface UnityBridgeEvent {
  event: string
  data: unknown
  at: number
}

/** The teaching line every unreachable/handshake surface carries — how the
 *  bridge becomes reachable is never a second question. */
export function unityBridgeHint(port: number): string {
  return (
    `is the Unity editor open on this project with the bridge package installed? ` +
    `op:"unity_bridge_install" materializes com.mercury.unity-bridge; the editor picks it up on ` +
    `focus/recompile and listens on 127.0.0.1:${port}; op:"unity_status" probes everything`
  )
}

/** Bounded raw-connect reachability probe (default 400ms). SAFE against the
 *  live session by the hello-time accept-newest law: a bare connect that
 *  never hellos can never displace the authed client (the server holds
 *  unauthed sockets to a receive deadline instead). */
export function probeUnityBridgeReachable(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

const MAX_EVENTS = 500
const HEARTBEAT_MS = 10_000
const PONG_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const BACKOFF_START_MS = 1_000
const BACKOFF_CAP_MS = 60_000
const CONNECT_TIMEOUT_MS = 3_000
const HELLO_TIMEOUT_MS = 5_000

function err(code: string, message: string, hint?: string): UnityBridgeResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

interface Pending {
  resolve: (r: UnityBridgeResult) => void
  timer: NodeJS.Timeout
  op: string
}

export class UnityBridgeClient {
  private readonly port: number
  private readonly token: string
  private socket: net.Socket | null = null
  private state: 'disconnected' | 'connecting' | 'ready' = 'disconnected'
  private closed = false
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Requests issued while the handshake is in flight. */
  private queue: Array<{ op: string; args: Record<string, unknown> | undefined; timeoutMs: number; resolve: (r: UnityBridgeResult) => void; queueTimer: NodeJS.Timeout | null }> = []
  /** The hello timer — cleared only when the HANDSHAKE FRAME settles, never
   *  on a raw data byte (a squatted port that keeps the socket open would
   *  otherwise defuse it and wedge 'connecting' forever). */
  private helloTimer: NodeJS.Timeout | null = null
  private events: UnityBridgeEvent[] = []
  private heartbeat: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private backoffMs: number
  private backoffUntil = 0
  private helloError: UnityBridgeError | null = null
  private lastHello: UnityBridgeHelloInfo | null = null
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

  /** The last successful hello's result (versions, project, play state at
   *  handshake time) — null until a handshake succeeds. Consumers read the
   *  fields defensively; the wire is not trusted to stay well-shaped. */
  helloInfo(): UnityBridgeHelloInfo | null {
    return this.lastHello
  }

  /** The fast-fail window's remaining ms (0 = clear). Proof seam + hint text. */
  backoffRemainingMs(now: number = Date.now()): number {
    return Math.max(0, this.backoffUntil - now)
  }

  /** The delay the NEXT failed connect will arm. Proof seam. */
  nextDelayMs(): number {
    return this.backoffMs
  }

  drainEvents(): UnityBridgeEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  async request(
    op: string,
    args?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<UnityBridgeResult> {
    if (this.closed) return err('CLIENT_CLOSED', 'the Unity bridge client was closed')
    if (this.state === 'ready') return this.send(op, args, timeoutMs)
    const remaining = this.backoffRemainingMs()
    if (remaining > 0) {
      return err(
        'EDITOR_UNREACHABLE',
        `the Unity bridge is not answering on 127.0.0.1:${this.port}`,
        `${unityBridgeHint(this.port)} — retrying in ${Math.ceil(remaining / 1000)}s`,
      )
    }
    return new Promise<UnityBridgeResult>(resolve => {
      // A request queued during 'connecting' carries its OWN deadline — a
      // handshake that never settles must not hang the caller (this file's
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
            `${op} timed out after ${timeoutMs}ms waiting for the bridge connection`,
            `${unityBridgeHint(this.port)}`,
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
    this.teardown(err('CLIENT_CLOSED', 'the Unity bridge client was closed'))
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
      socket.write(buildUnityBridgeHelloFrame(this.token))
    })
    // Data does NOT clear the hello timer — only a parsed handshake frame
    // does (onFrame). A peer dribbling bytes without a frame dies at the
    // handshake deadline instead of wedging 'connecting' forever.
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
    if (this.buf.length > UNITY_BRIDGE_MAX_LINE_BYTES) {
      this.socket?.destroy(new Error('oversized frame'))
      return
    }
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      const frame = parseUnityBridgeFrame(line)
      if (frame.kind === 'unknown') {
        if (this.state === 'connecting') {
          // An unparseable FIRST payload means the peer is not a bridge (a
          // squatted port) — die now, bounded, instead of resyncing forever
          // on a stream that will never hand us a frame.
          this.socket?.destroy(new Error('unparseable handshake payload — not a Unity bridge?'))
          return
        }
        continue // one bad frame never kills the stream; the next line resyncs
      }
      this.onFrame(frame)
    }
  }

  private onFrame(frame: Exclude<ReturnType<typeof parseUnityBridgeFrame>, { kind: 'unknown' }>): void {
    if (this.state === 'connecting') {
      // The first frame answers the hello — THIS settles the hello timer.
      if (this.helloTimer) {
        clearTimeout(this.helloTimer)
        this.helloTimer = null
      }
      if ((frame.kind === 'hello-reply' || frame.kind === 'response') && frame.ok === true) {
        // THE SKEW ARM: an ok-hello still refuses across a version gap.
        const info = (frame.result ?? null) as UnityBridgeHelloInfo | null
        const remote = typeof info?.version === 'number' ? info.version : undefined
        if (remote !== UNITY_BRIDGE_PROTOCOL_VERSION) {
          this.helloError = {
            code: 'BRIDGE_VERSION_SKEW',
            message: `the bridge package speaks protocol ${remote ?? '(unstated)'} but this Mercury speaks ${UNITY_BRIDGE_PROTOCOL_VERSION}`,
            hint: 'op:"unity_bridge_install" refreshes the bundled package so both halves match',
          }
          this.socket?.destroy(new Error('bridge protocol version skew'))
          return
        }
        this.lastHello = info
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
        const e = 'error' in frame ? frame.error : undefined
        this.helloError = e ?? { code: 'AUTH_FAILED', message: 'handshake refused' }
        // The server drops the socket next; onConnectionDown reports helloError.
      }
      return
    }
    if (frame.kind === 'response' && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.ok === true) p.resolve({ ok: true, result: frame.result })
      else {
        p.resolve({
          ok: false,
          error: frame.error ?? { code: 'BAD_FRAME', message: 'error frame without error body' },
        })
      }
      return
    }
    if (frame.kind === 'event') {
      this.events.push({ event: frame.event, data: frame.data, at: Date.now() })
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    }
  }

  private send(
    op: string,
    args: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<UnityBridgeResult> {
    const socket = this.socket
    if (!socket || this.state !== 'ready') {
      return Promise.resolve(err('CONNECTION_LOST', `connection lost before ${op} was sent`))
    }
    const id = this.nextId++
    return new Promise<UnityBridgeResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(
          err(
            'REQUEST_TIMEOUT',
            `${op} did not answer within ${timeoutMs}ms`,
            'the editor may be busy (import, compile, play transition); retry, or op:"unity_status" to probe',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer, op })
      socket.write(buildUnityBridgeRequestFrame(id, op, args))
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
      socket.write(buildUnityBridgeRequestFrame(id, 'ping'))
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
    const reason: UnityBridgeResult = wasConnecting
      ? this.helloError
        ? { ok: false, error: this.helloError }
        : err(
            'HANDSHAKE_CLOSED',
            `could not establish the bridge handshake on 127.0.0.1:${this.port}`,
            unityBridgeHint(this.port),
          )
      : err(
          'CONNECTION_LOST',
          'the editor connection dropped mid-flight (a play-mode domain reload does this by design)',
          'retry — the client reconnects on the next call',
        )
    this.teardown(reason)
    // Arm the fast-fail window (doubles to the cap; reset on the next hello-ok).
    this.backoffUntil = Date.now() + this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffCapMs)
  }

  private teardown(reason: UnityBridgeResult): void {
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

let singleton: { client: UnityBridgeClient; key: string } | null = null

/** The session client, or null when the surface is off / not a Unity
 *  project. Token side effect (file create) happens only here — armed paths
 *  only. */
export function getUnityBridgeClient(): UnityBridgeClient | null {
  if (!unityBridgeEnabled()) return null
  const root = findUnityProjectRoot()
  if (!root) return null
  const port = unityBridgePort()
  const key = `${root}#${port}`
  if (singleton && singleton.key === key) return singleton.client
  singleton?.client.close()
  const client = new UnityBridgeClient({ port, token: ensureUnityBridgeToken(root) })
  singleton = { client, key }
  return client
}

export function resetUnityBridgeClientForTest(): void {
  singleton?.client.close()
  singleton = null
}
