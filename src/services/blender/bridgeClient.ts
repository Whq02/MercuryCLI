// ============================================================================
//  bridgeClient — Mercury's side of the BLENDER-BRIDGE loopback protocol
//  (NDJSON over TCP to the mercury_blender_bridge add-on; the wire contract
//  lives WHOLE in services/blender/bridgeProtocol.ts — this module adds
//  transport behavior only). The unity bridgeClient grammar, kept exactly:
//
//   · loopback ONLY by construction — the API takes a port, never a host.
//   · hello+token is the first frame; the server answers {ok:true,…} or an
//     error frame and drops. Handshake failures surface as AUTH_FAILED /
//     VERSION_SKEW / HANDSHAKE_CLOSED, never hangs.
//   · THE SKEW ARM: a hello answered ok but carrying a foreign
//     result.version refuses BRIDGE_VERSION_SKEW naming both versions — no
//     op is ever sent across a version gap.
//   · request/response correlation by integer id; per-request timeout
//     (default 30s) answers REQUEST_TIMEOUT with the op named.
//   · heartbeat: a ping every 10s while ready; a missed pong (5s) destroys
//     the connection (a wedged Blender is a dead connection, not a hang).
//   · reconnect backoff: a failed connect arms a fast-fail window that
//     doubles 1s → 60s (reset on success); requests inside the window answer
//     EDITOR_UNREACHABLE immediately with the teaching hint. The next
//     request after the window reconnects automatically. NOTE the deliberate
//     difference from the unity sibling: Blender has NO domain reload — a
//     mid-flight drop here means Blender quit or the add-on was disabled,
//     never a by-design transition (the no-reload law; the fake pins
//     connection-survives-open).
//   · unsolicited {event,data} frames buffer in a bounded ring (500) —
//     drainEvents() hands them to the tool layer.
//   · request() NEVER throws — every failure is {ok:false, error:{code,
//     message, hint}}.
//
//  Proof: scripts/blender-bridge/prove-blender-bridge-protocol.ts against
//  the scripted fake bridge (scripts/blender-bridge/fake-bridge.ts).
// ============================================================================

import * as net from 'node:net'
import { blenderBridgeEnabled, blenderBridgePort } from '../../utils/blender/bridgeGates.js'
import {
  BLENDER_BRIDGE_MAX_LINE_BYTES,
  BLENDER_BRIDGE_PROTOCOL_VERSION,
  buildBlenderBridgeHelloFrame,
  buildBlenderBridgeRequestFrame,
  parseBlenderBridgeFrame,
  type BlenderBridgeError,
  type BlenderBridgeHelloInfo,
  type BlenderBridgeResult,
} from './bridgeProtocol.js'
import { resolveBlenderAddonHome } from './addonHome.js'
import { ensureBlenderBridgeToken } from './bridgeToken.js'
import { blenderBridgeTokenOverride } from '../../utils/blender/bridgeGates.js'

export type { BlenderBridgeError, BlenderBridgeResult } from './bridgeProtocol.js'

export interface BlenderBridgeEvent {
  event: string
  data: unknown
  at: number
}

/** The teaching line every unreachable/handshake surface carries — how the
 *  bridge becomes reachable is never a second question. The ENABLE step is
 *  Blender-specific and named: materialized add-ons are not live until the
 *  operator enables them in Preferences (install never automates that). */
export function blenderBridgeHint(port: number): string {
  return (
    `is Blender open with the Mercury bridge add-on installed AND enabled? ` +
    `op:"blender_bridge_install" materializes mercury_blender_bridge into the user addon home; ` +
    `enable it in Blender (Edit > Preferences > Add-ons, search "Mercury") — it then listens on ` +
    `127.0.0.1:${port}; op:"blender_status" probes everything`
  )
}

/** Bounded raw-connect reachability probe (default 400ms). SAFE against the
 *  live session by the hello-time accept-newest law: a bare connect that
 *  never hellos can never displace the authed client (the server holds
 *  unauthed sockets to a receive deadline instead). */
export function probeBlenderBridgeReachable(port: number, timeoutMs = 400): Promise<boolean> {
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

function err(code: string, message: string, hint?: string): BlenderBridgeResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

interface Pending {
  resolve: (r: BlenderBridgeResult) => void
  timer: NodeJS.Timeout
  op: string
}

export class BlenderBridgeClient {
  private readonly port: number
  private readonly token: string
  private socket: net.Socket | null = null
  private state: 'disconnected' | 'connecting' | 'ready' = 'disconnected'
  private closed = false
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Requests issued while the handshake is in flight. */
  private queue: Array<{ op: string; args: Record<string, unknown> | undefined; timeoutMs: number; resolve: (r: BlenderBridgeResult) => void; queueTimer: NodeJS.Timeout | null }> = []
  /** The hello timer — cleared only when the HANDSHAKE FRAME settles, never
   *  on a raw data byte (a squatted port that keeps the socket open would
   *  otherwise defuse it and wedge 'connecting' forever). */
  private helloTimer: NodeJS.Timeout | null = null
  private events: BlenderBridgeEvent[] = []
  private heartbeat: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private backoffMs: number
  private backoffUntil = 0
  private helloError: BlenderBridgeError | null = null
  private lastHello: BlenderBridgeHelloInfo | null = null
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

  /** The last successful hello's result (versions, blend file, background
   *  truth at handshake time) — null until a handshake succeeds. Consumers
   *  read the fields defensively; the wire is not trusted to stay
   *  well-shaped. */
  helloInfo(): BlenderBridgeHelloInfo | null {
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

  drainEvents(): BlenderBridgeEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  async request(
    op: string,
    args?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<BlenderBridgeResult> {
    if (this.closed) return err('CLIENT_CLOSED', 'the Blender bridge client was closed')
    if (this.state === 'ready') return this.send(op, args, timeoutMs)
    const remaining = this.backoffRemainingMs()
    if (remaining > 0) {
      return err(
        'EDITOR_UNREACHABLE',
        `the Blender bridge is not answering on 127.0.0.1:${this.port}`,
        `${blenderBridgeHint(this.port)} — retrying in ${Math.ceil(remaining / 1000)}s`,
      )
    }
    return new Promise<BlenderBridgeResult>(resolve => {
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
            `${blenderBridgeHint(this.port)}`,
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
    this.teardown(err('CLIENT_CLOSED', 'the Blender bridge client was closed'))
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
      socket.write(buildBlenderBridgeHelloFrame(this.token))
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
    if (this.buf.length > BLENDER_BRIDGE_MAX_LINE_BYTES) {
      this.socket?.destroy(new Error('oversized frame'))
      return
    }
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      const frame = parseBlenderBridgeFrame(line)
      if (frame.kind === 'unknown') {
        if (this.state === 'connecting') {
          // An unparseable FIRST payload means the peer is not a bridge (a
          // squatted port) — die now, bounded, instead of resyncing forever
          // on a stream that will never hand us a frame.
          this.socket?.destroy(new Error('unparseable handshake payload — not a Blender bridge?'))
          return
        }
        continue // one bad frame never kills the stream; the next line resyncs
      }
      this.onFrame(frame)
    }
  }

  private onFrame(frame: Exclude<ReturnType<typeof parseBlenderBridgeFrame>, { kind: 'unknown' }>): void {
    if (this.state === 'connecting') {
      // The first frame answers the hello — THIS settles the hello timer.
      if (this.helloTimer) {
        clearTimeout(this.helloTimer)
        this.helloTimer = null
      }
      if ((frame.kind === 'hello-reply' || frame.kind === 'response') && frame.ok === true) {
        // THE SKEW ARM: an ok-hello still refuses across a version gap.
        const info = (frame.result ?? null) as BlenderBridgeHelloInfo | null
        const remote = typeof info?.version === 'number' ? info.version : undefined
        if (remote !== BLENDER_BRIDGE_PROTOCOL_VERSION) {
          this.helloError = {
            code: 'BRIDGE_VERSION_SKEW',
            message: `the bridge add-on speaks protocol ${remote ?? '(unstated)'} but this Mercury speaks ${BLENDER_BRIDGE_PROTOCOL_VERSION}`,
            hint: 'op:"blender_bridge_install" refreshes the bundled add-on so both halves match (Blender reloads it on restart or via the add-on refresh)',
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
  ): Promise<BlenderBridgeResult> {
    const socket = this.socket
    if (!socket || this.state !== 'ready') {
      return Promise.resolve(err('CONNECTION_LOST', `connection lost before ${op} was sent`))
    }
    const id = this.nextId++
    return new Promise<BlenderBridgeResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(
          err(
            'REQUEST_TIMEOUT',
            `${op} did not answer within ${timeoutMs}ms`,
            'Blender may be busy (a long python_run blocks the main thread by design; a render job holds it too); retry, or op:"blender_status" to probe',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer, op })
      socket.write(buildBlenderBridgeRequestFrame(id, op, args))
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
      socket.write(buildBlenderBridgeRequestFrame(id, 'ping'))
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
    const reason: BlenderBridgeResult = wasConnecting
      ? this.helloError
        ? { ok: false, error: this.helloError }
        : err(
            'HANDSHAKE_CLOSED',
            `could not establish the bridge handshake on 127.0.0.1:${this.port}`,
            blenderBridgeHint(this.port),
          )
      : err(
          'CONNECTION_LOST',
          'the Blender connection dropped mid-flight (did Blender quit, or was the add-on disabled? Blender has no reload that drops this by design)',
          'retry — the client reconnects on the next call',
        )
    this.teardown(reason)
    // Arm the fast-fail window (doubles to the cap; reset on the next hello-ok).
    this.backoffUntil = Date.now() + this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffCapMs)
  }

  private teardown(reason: BlenderBridgeResult): void {
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

let singleton: { client: BlenderBridgeClient; key: string } | null = null

/** The session client, or null when the surface is off / no token address
 *  exists. DELIBERATE difference from the unity sibling, recorded: the
 *  token is per-INSTALL (user-scoped), so there is NO project scoping here —
 *  armed is enough when a token can be resolved (override, or the addon
 *  home). Token side effect (file create) happens only here — armed paths
 *  only. */
export function getBlenderBridgeClient(): BlenderBridgeClient | null {
  if (!blenderBridgeEnabled()) return null
  const port = blenderBridgePort()
  const override = blenderBridgeTokenOverride()
  let token: string
  if (override) {
    token = override
  } else {
    const census = resolveBlenderAddonHome()
    if (!census.home) return null // no token address — blender_status explains
    token = ensureBlenderBridgeToken(census.home.path)
  }
  const key = `#${port}`
  if (singleton && singleton.key === key) return singleton.client
  singleton?.client.close()
  const client = new BlenderBridgeClient({ port, token })
  singleton = { client, key }
  return client
}

export function resetBlenderBridgeClientForTest(): void {
  singleton?.client.close()
  singleton = null
}
