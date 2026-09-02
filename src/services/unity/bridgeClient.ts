
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

export function unityBridgeHint(port: number): string {
  return (
    `is the Unity editor open on this project with the bridge package installed? ` +
    `op:"unity_bridge_install" materializes com.mercury.unity-bridge; the editor picks it up on ` +
    `focus/recompile and listens on 127.0.0.1:${port}; op:"unity_status" probes everything`
  )
}

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
  private queue: Array<{ op: string; args: Record<string, unknown> | undefined; timeoutMs: number; resolve: (r: UnityBridgeResult) => void; queueTimer: NodeJS.Timeout | null }> = []
  private helloTimer: NodeJS.Timeout | null = null
  private events: UnityBridgeEvent[] = []
  private heartbeat: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private backoffMs: number
  private backoffUntil = 0
  private helloError: UnityBridgeError | null = null
  private lastHello: UnityBridgeHelloInfo | null = null
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

  helloInfo(): UnityBridgeHelloInfo | null {
    return this.lastHello
  }

  backoffRemainingMs(now: number = Date.now()): number {
    return Math.max(0, this.backoffUntil - now)
  }

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
    socket.on('data', chunk => {
      this.onData(chunk.toString('utf8'))
    })
    const fail = () => {
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
          this.socket?.destroy(new Error('unparseable handshake payload — not a Unity bridge?'))
          return
        }
        continue
      }
      this.onFrame(frame)
    }
  }

  private onFrame(frame: Exclude<ReturnType<typeof parseUnityBridgeFrame>, { kind: 'unknown' }>): void {
    if (this.state === 'connecting') {
      if (this.helloTimer) {
        clearTimeout(this.helloTimer)
        this.helloTimer = null
      }
      if ((frame.kind === 'hello-reply' || frame.kind === 'response') && frame.ok === true) {
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
        socket.destroy(new Error('missed pong'))
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


let singleton: { client: UnityBridgeClient; key: string } | null = null

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
