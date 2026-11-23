import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { connect as netConnect, type Socket } from 'node:net'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { pollUntil } from '../../../platform/async/deadline.js'
import { DapCancelledError, dapDeadline } from '../dapCancellation.js'
import type { Pending } from './shared.js'

interface WireNeeds {
  terminated(): boolean
  exitDetail(): string
  alive(): boolean
  transportReady(): Promise<void>
  child(): ChildProcessWithoutNullStreams | null
  socketClosed(closedDetail: string): void
  onMessage(msg: Record<string, unknown>): void
}

export class WirePart {
  #socket: Socket | null = null
  #seq = 1
  #pending = new Map<number, Pending>()
  #buffer = Buffer.alloc(0)

  constructor(private readonly needs: WireNeeds) {}

  pending(): Map<number, Pending> {
    return this.#pending
  }

  socket(): Socket | null {
    return this.#socket
  }

  async connectTcp(port: number, host = '127.0.0.1', deadlineMs = 6_000): Promise<void> {
    const socket = await pollUntil(
      async () => {
        if (this.needs.terminated()) throw new Error(this.needs.exitDetail() || 'adapter exited before the tcp port opened')
        const connected = await new Promise<Socket | null>(resolve => {
          const s = netConnect({ host, port }, () => resolve(s))
          s.on('error', () => resolve(null))
        })
        return connected ?? undefined
      },
      100,
      deadlineMs,
      () => {
        throw new Error(`adapter never opened ${host}:${port} within ${deadlineMs}ms`)
      },
    )
    await this.adoptSocket(socket, 'adapter socket closed')
  }

  adoptSocket(socket: Socket, closedDetail: string): Promise<void> {
    this.#socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('close', () => {
      this.needs.socketClosed(closedDetail)
      for (const [, p] of this.#pending) {
        p.cancelDeadline()
        p.reject(new Error(this.needs.exitDetail()))
      }
      this.#pending.clear()
    })
    socket.on('error', () => undefined)
    return Promise.resolve()
  }

  onData(chunk: Buffer): void {
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
        this.needs.onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        logForDebugging(`dap: unparseable message body (${length} bytes)`)
      }
    }
  }

  onResponse(msg: Record<string, unknown>): void {
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
  }

  #writeFrame(payload: string, onError?: (err: Error) => void, isCurrent: () => boolean = () => true): void {
    const framed = `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`
    void this.needs.transportReady()
      .then(() => {
        if (!isCurrent()) return
        const wire = this.#socket ?? this.needs.child()?.stdin
        if (!wire) throw new Error(this.needs.exitDetail() || 'session has no transport')
        wire.write(framed, err => {
          if (err) onError?.(err)
        })
      })
      .catch(err => onError?.(err as Error))
  }

  respondToReverse(request: Record<string, unknown>, success: boolean, message?: string, body: Record<string, unknown> = {}): void {
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

  request(command: string, args: Record<string, unknown> | undefined, timeoutMs: number, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(new DapCancelledError())
    if (!this.needs.alive() && command !== 'disconnect') {
      return Promise.reject(new Error(this.needs.exitDetail() || 'session is not alive'))
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
}
