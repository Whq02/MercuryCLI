import type { Readable, Writable } from 'node:stream'
import {
  BAD_LINE_LIMIT,
  MAX_LINE_BYTES,
  RPC_CANCELLED,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR,
  RpcError,
  cancelled,
  invalidParams,
  methodNotFound,
  notInitialized,
  refused,
  rpcErrorOf,
  type RpcErrorShape,
} from './errors.js'
import { METHODS, RUNNER_PROTOCOL, checkParams, checkResult, deadlineOf, isMethodName, type MethodName, type MethodScope, type MethodSpec, type ParamsOf, type ResultOf } from './methods.js'
import { rowOf, RowSchemaMismatch } from '../../rows/read.js'

export type RpcId = number
export type RpcRequest = { jsonrpc: '2.0'; id: RpcId; method: string; params?: unknown }
export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId | null; result?: unknown; error?: RpcErrorShape }
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse

export type PeerSide = 'host' | 'runner'

export class PeerClosed extends Error {
  readonly method: string
  constructor(method: string, reason: string) {
    super(`${method}: the peer closed (${reason})`)
    this.name = 'PeerClosed'
    this.method = method
  }
}

export class PeerDeadline extends Error {
  readonly method: string
  readonly id: RpcId
  readonly deadlineMs: number
  constructor(method: string, id: RpcId, deadlineMs: number) {
    super(`${method}: no answer within ${deadlineMs} ms`)
    this.name = 'PeerDeadline'
    this.method = method
    this.id = id
    this.deadlineMs = deadlineMs
  }
}

export interface PeerOptions {
  input: Readable
  output: Writable
  side: PeerSide
  maxLineBytes?: number
  badLineLimit?: number
  onDesync?: (badLines: number) => void
  onProtocolError?: (error: RpcError) => void
  onWriteError?: (error: Error) => void
  serialize?: (message: RpcMessage) => string
  log?: (line: string) => void
}

export interface HandlerContext {
  id: RpcId
  signal: AbortSignal
  peer: Peer
}

export type RequestHandler<M extends MethodName> = (params: ParamsOf<M>, ctx: HandlerContext) => ResultOf<M> | Promise<ResultOf<M>>
export type NotificationHandler<M extends MethodName> = (params: ParamsOf<M>) => void | Promise<void>

export interface RequestOptions {
  deadlineMs?: number | null
  signal?: AbortSignal
}

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

type InFlight = {
  method: string
  controller: AbortController
  answered: boolean
}

type Hold = {
  count: number
  open: Promise<void>
  release: () => void
}

type Line = { kind: 'line'; text: string } | { kind: 'overlong'; bytes: number }

export class LineSplitter {
  private chunks: Buffer[] = []
  private size = 0
  private skipping = false
  private skipped = 0
  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  feed(chunk: Buffer | string): Line[] {
    const lines: Line[] = []
    let buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    while (buffer.length > 0) {
      const nl = buffer.indexOf(0x0a)
      if (nl < 0) {
        if (this.skipping) {
          this.skipped += buffer.length
        } else if (this.size + buffer.length > this.maxLineBytes) {
          this.skipping = true
          this.skipped = this.size + buffer.length
          this.chunks = []
          this.size = 0
        } else {
          this.chunks.push(buffer)
          this.size += buffer.length
        }
        break
      }
      const head = buffer.subarray(0, nl)
      buffer = buffer.subarray(nl + 1)
      if (this.skipping) {
        lines.push({ kind: 'overlong', bytes: this.skipped + head.length })
        this.skipping = false
        this.skipped = 0
        continue
      }
      if (this.size + head.length > this.maxLineBytes) {
        lines.push({ kind: 'overlong', bytes: this.size + head.length })
        this.chunks = []
        this.size = 0
        continue
      }
      this.chunks.push(head)
      const text = Buffer.concat(this.chunks).toString('utf8')
      this.chunks = []
      this.size = 0
      lines.push({ kind: 'line', text: text.endsWith('\r') ? text.slice(0, -1) : text })
    }
    return lines
  }

  flush(): Line[] {
    if (this.skipping) {
      const bytes = this.skipped
      this.skipping = false
      this.skipped = 0
      return [{ kind: 'overlong', bytes }]
    }
    if (this.size === 0) return []
    const text = Buffer.concat(this.chunks).toString('utf8')
    this.chunks = []
    this.size = 0
    return [{ kind: 'line', text }]
  }
}

class OrderedWriter {
  private held: Array<{ line: string; requestId?: RpcId }> | null
  private ended = false
  private readonly onWriteError: (error: Error) => void
  private readonly serialize: (message: RpcMessage) => string
  constructor(
    private readonly output: Writable,
    hold: boolean,
    opts: { onWriteError?: (error: Error) => void; serialize?: (message: RpcMessage) => string } = {},
  ) {
    this.held = hold ? [] : null
    this.onWriteError = opts.onWriteError ?? (() => {})
    this.serialize = opts.serialize ?? (message => JSON.stringify(message))
  }

  write(message: RpcMessage, bypassHold = false): void {
    if (this.ended) return
    const line = this.serialize(message) + '\n'
    if (this.held !== null && !bypassHold) {
      this.held.push({ line, ...('method' in message && 'id' in message ? { requestId: message.id } : {}) })
      return
    }
    this.put(line)
  }

  private put(line: string): void {
    this.output.write(line, error => {
      if (error) this.onWriteError(error)
    })
  }

  release(): void {
    if (this.held === null) return
    const lines = this.held
    this.held = null
    if (this.ended) return
    for (const entry of lines) this.put(entry.line)
  }

  withdraw(id: RpcId): boolean {
    if (this.held === null) return false
    const at = this.held.findIndex(entry => entry.requestId === id)
    if (at < 0) return false
    this.held.splice(at, 1)
    return true
  }

  flush(): Promise<void> {
    if (this.ended) return Promise.resolve()
    return new Promise(resolve => {
      this.output.write('', () => resolve())
    })
  }

  get holding(): boolean {
    return this.held !== null
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.held = null
    this.output.end()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export class Peer {
  readonly side: PeerSide
  readonly done: Promise<void>
  private readonly input: Readable
  private readonly writer: OrderedWriter
  private readonly splitter: LineSplitter
  private readonly badLineLimit: number
  private readonly onDesync: (badLines: number) => void
  private readonly onProtocolError: (error: RpcError) => void
  private readonly log: (line: string) => void
  private settleDone!: () => void
  private nextId = 0
  private badLines = 0
  private closedReason: string | null = null
  private initState: 'none' | 'pending' | 'done'
  private initWaiters: Array<{ id: RpcId; run: () => void; fail: () => void }> = []
  private readonly pending = new Map<RpcId, Pending>()
  private readonly inFlight = new Map<RpcId, InFlight>()
  private readonly requestHandlers = new Map<string, (params: unknown, ctx: HandlerContext) => unknown>()
  private readonly notificationHandlers = new Map<string, (params: unknown) => unknown>()
  private readonly chains = new Map<MethodScope, Promise<void>>()
  private readonly holds = new Map<MethodScope, Hold>()
  private readonly onData: (chunk: Buffer | string) => void
  private readonly onEnd: () => void
  private readonly onError: (error: Error) => void

  constructor(opts: PeerOptions) {
    this.side = opts.side
    this.input = opts.input
    this.writer = new OrderedWriter(opts.output, opts.side === 'runner', { onWriteError: opts.onWriteError, serialize: opts.serialize })
    this.splitter = new LineSplitter(opts.maxLineBytes ?? MAX_LINE_BYTES)
    this.badLineLimit = opts.badLineLimit ?? BAD_LINE_LIMIT
    this.onDesync = opts.onDesync ?? (() => {})
    this.log = opts.log ?? (() => {})
    this.onProtocolError = opts.onProtocolError ?? (error => this.log(error.message))
    this.initState = opts.side === 'runner' ? 'none' : 'done'
    this.done = new Promise<void>(resolve => {
      this.settleDone = resolve
    })
    this.onData = chunk => {
      for (const line of this.splitter.feed(chunk)) this.onLine(line)
    }
    this.onEnd = () => {
      for (const line of this.splitter.flush()) this.onLine(line)
      this.close('input ended')
    }
    this.onError = error => this.close(`input failed: ${error.message}`)
    this.input.on('data', this.onData)
    this.input.on('end', this.onEnd)
    this.input.on('close', this.onEnd)
    this.input.on('error', this.onError)
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  get initialized(): boolean {
    return this.initState === 'done'
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  get holdingOutput(): boolean {
    return this.writer.holding
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  onRequest<M extends MethodName>(method: M, handler: RequestHandler<M>): this {
    this.requestHandlers.set(method, handler as (params: unknown, ctx: HandlerContext) => unknown)
    return this
  }

  onNotification<M extends MethodName>(method: M, handler: NotificationHandler<M>): this {
    this.notificationHandlers.set(method, handler as (params: unknown) => unknown)
    return this
  }

  request<M extends MethodName>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): Promise<ResultOf<M>> {
    return this.send(method, params, opts).answer
  }

  send<M extends MethodName>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): { id: RpcId; answer: Promise<ResultOf<M>> } {
    if (this.closedReason !== null) return { id: 0, answer: Promise.reject(new PeerClosed(method, this.closedReason)) }
    if (opts.signal?.aborted) return { id: 0, answer: Promise.reject(cancelled('aborted')) }
    const id = ++this.nextId
    const deadlineMs = opts.deadlineMs === undefined ? deadlineOf(method) : opts.deadlineMs
    const answer = new Promise<ResultOf<M>>((resolve, reject) => {
      const timer =
        deadlineMs !== null
          ? setTimeout(() => {
              if (!this.pending.delete(id)) return
              if (!this.writer.withdraw(id)) this.notify('$/cancel_request', { request_id: id, reason: 'deadline' })
              reject(new PeerDeadline(method, id, deadlineMs))
            }, deadlineMs)
          : null
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
    })
    if (opts.signal !== undefined) {
      const signal = opts.signal
      const abort = (): void => {
        this.cancel(id, typeof signal.reason === 'string' && signal.reason !== '' ? signal.reason : 'aborted')
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    this.writer.write({ jsonrpc: '2.0', id, method, params })
    return { id, answer }
  }

  notify<M extends MethodName>(method: M, params: ParamsOf<M>): void {
    this.writer.write({ jsonrpc: '2.0', method, params })
  }

  cancel(id: RpcId, reason?: string): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    if (!this.writer.withdraw(id)) this.notify('$/cancel_request', reason === undefined ? { request_id: id } : { request_id: id, reason })
    entry.reject(cancelled(reason))
    return true
  }

  holdScope(scope: MethodScope): () => void {
    let hold = this.holds.get(scope)
    if (hold === undefined || hold.count === 0) {
      let release: () => void = () => {}
      const open = new Promise<void>(resolve => {
        release = resolve
      })
      hold = { count: 0, open, release }
      this.holds.set(scope, hold)
    }
    const held = hold
    held.count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      held.count -= 1
      if (held.count === 0) held.release()
    }
  }

  close(reason = 'closed'): void {
    if (this.closedReason !== null) return
    this.closedReason = reason
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('close', this.onEnd)
    this.input.off('error', this.onError)
    for (const [id, entry] of this.pending) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new PeerClosed(entry.method, reason))
    }
    for (const [id, entry] of this.inFlight) {
      entry.answered = true
      entry.controller.abort()
      this.inFlight.delete(id)
    }
    const waiters = this.initWaiters
    this.initWaiters = []
    for (const waiter of waiters) waiter.fail()
    this.settleDone()
  }

  end(reason = 'ended'): void {
    this.close(reason)
    this.writer.end()
  }

  private failProtocol(error: RpcError): void {
    if (this.closed) return
    for (const [id, entry] of this.pending) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(error)
    }
    this.end(error.message)
    this.onProtocolError(error)
  }

  private onLine(line: Line): void {
    if (this.closed) return
    if (line.kind === 'overlong') {
      this.log(`runner wire: a line of ${line.bytes} bytes passed the ${MAX_LINE_BYTES}-byte bound and was dropped`)
      this.badLine()
      this.writer.write({ jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: `line too long (${line.bytes} bytes)` } }, true)
      return
    }
    if (line.text.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line.text.charCodeAt(0) === 0xfeff ? line.text.slice(1) : line.text)
    } catch (error) {
      this.badLine()
      this.writer.write({ jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: `parse error: ${error instanceof Error ? error.message : String(error)}` } }, true)
      return
    }
    this.badLines = 0
    if (Array.isArray(value)) {
      this.writer.write({ jsonrpc: '2.0', id: null, error: { code: RPC_INVALID_REQUEST, message: 'batches are not accepted: one message per line' } }, true)
      return
    }
    if (!isRecord(value) || value.jsonrpc !== '2.0') {
      const id = isRecord(value) && isRpcId(value.id) ? value.id : null
      this.writer.write({ jsonrpc: '2.0', id, error: { code: RPC_INVALID_REQUEST, message: 'not a JSON-RPC 2.0 message' } }, true)
      return
    }
    if (typeof value.method === 'string') {
      if (value.id === undefined) {
        this.onNotificationLine(value.method, value.params)
        return
      }
      if (!isRpcId(value.id)) {
        this.writer.write({ jsonrpc: '2.0', id: null, error: { code: RPC_INVALID_REQUEST, message: 'id must be a positive integer' } }, true)
        return
      }
      this.onRequestLine(value.id, value.method, value.params)
      return
    }
    if (('result' in value || 'error' in value) && value.id !== undefined) {
      this.onResponseLine(value)
      return
    }
    this.writer.write({ jsonrpc: '2.0', id: isRpcId(value.id) ? value.id : null, error: { code: RPC_INVALID_REQUEST, message: 'neither a request, a notification nor a response' } }, true)
  }

  private badLine(): void {
    this.badLines += 1
    if (this.badLines >= this.badLineLimit) {
      this.log(`runner wire: ${this.badLines} consecutive unreadable lines — the stream is out of step`)
      this.onDesync(this.badLines)
    }
  }

  private serves(spec: MethodSpec): boolean {
    if (spec.from === 'both') return true
    return this.side === 'runner' ? spec.from === 'host' : spec.from === 'runner'
  }

  private onNotificationLine(method: string, params: unknown): void {
    if (method === '$/cancel_request') {
      const check = checkParams('$/cancel_request', params)
      if (!check.ok) return
      const waiting = this.initWaiters.findIndex(entry => entry.id === check.value.request_id)
      if (waiting >= 0) {
        this.initWaiters.splice(waiting, 1)
        this.writer.write({ jsonrpc: '2.0', id: check.value.request_id, error: cancelled(check.value.reason).toJSON() }, true)
        return
      }
      const entry = this.inFlight.get(check.value.request_id)
      if (entry === undefined || entry.answered) {
        this.log(`runner wire: $/cancel_request for ${check.value.request_id}, which is not in flight`)
        return
      }
      entry.answered = true
      if (check.value.reason === undefined) entry.controller.abort()
      else entry.controller.abort(check.value.reason)
      this.inFlight.delete(check.value.request_id)
      this.answer(check.value.request_id, entry.method, { error: cancelled(check.value.reason).toJSON() })
      return
    }
    const spec = isMethodName(method) ? (METHODS[method] as MethodSpec) : undefined
    if (spec === undefined || spec.kind !== 'notification' || !this.serves(spec)) {
      this.log(`runner wire: notification ${method} is not one this side reads`)
      return
    }
    if (method === 'row') {
      try {
        rowOf(params)
      } catch (error) {
        if (!(error instanceof RowSchemaMismatch)) throw error
        this.failProtocol(refused(error.message, 'protocol', { row: error.rowType, schema: error.schema }))
        return
      }
    }
    const handler = this.notificationHandlers.get(method)
    if (handler === undefined) return
    const check = checkParams(method as MethodName, params)
    if (!check.ok) {
      this.log(`runner wire: notification ${method} carried params its schema refused`)
      return
    }
    void Promise.resolve()
      .then(() => handler(check.value))
      .catch(error => this.log(`runner wire: notification ${method} failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private onRequestLine(id: RpcId, method: string, params: unknown): void {
    if (this.inFlight.has(id) || this.initWaiters.some(entry => entry.id === id)) {
      this.writer.write({ jsonrpc: '2.0', id, error: { code: RPC_INVALID_REQUEST, message: `id ${id} is already in flight` } }, true)
      return
    }
    if (method === 'initialize' && this.side === 'runner') {
      if (this.initState !== 'none') {
        this.writer.write({ jsonrpc: '2.0', id, error: refused('already initialized', 'already-initialized').toJSON() }, true)
        return
      }
      this.initState = 'pending'
      this.dispatch(id, method, params)
      return
    }
    if (this.initState === 'none') {
      this.writer.write({ jsonrpc: '2.0', id, error: notInitialized(method).toJSON() }, true)
      return
    }
    if (this.initState === 'pending') {
      this.initWaiters.push({
        id,
        run: () => this.dispatch(id, method, params),
        fail: () => this.writer.write({ jsonrpc: '2.0', id, error: notInitialized(method).toJSON() }, true),
      })
      return
    }
    this.dispatch(id, method, params)
  }

  private dispatch(id: RpcId, method: string, params: unknown): void {
    const spec = isMethodName(method) ? (METHODS[method] as MethodSpec) : undefined
    const handler = this.requestHandlers.get(method)
    if (spec === undefined || spec.kind !== 'request' || !this.serves(spec) || handler === undefined) {
      this.answer(id, method, { error: methodNotFound(method).toJSON() })
      return
    }
    if (method === 'initialize' && isRecord(params) && typeof params.protocol === 'number' && params.protocol !== RUNNER_PROTOCOL) {
      this.answer(id, method, { error: refused(`runner protocol ${String(params.protocol)} is not supported; expected ${RUNNER_PROTOCOL}`, 'protocol', { protocol: RUNNER_PROTOCOL }).toJSON() })
      return
    }
    const check = checkParams(method as MethodName, params)
    if (!check.ok) {
      this.answer(id, method, { error: invalidParams(method, check.issues).toJSON() })
      return
    }
    const controller = new AbortController()
    const entry: InFlight = { method, controller, answered: false }
    this.inFlight.set(id, entry)
    const run = async (): Promise<void> => {
      if (entry.answered) return
      try {
        const result = await handler(check.value, { id, signal: controller.signal, peer: this })
        this.settle(id, entry, { result: result === undefined ? {} : result })
      } catch (error) {
        this.settle(id, entry, { error: rpcErrorOf(error) })
      }
    }
    if (spec.scope === 'none') {
      void run()
      return
    }
    const previous = this.chains.get(spec.scope) ?? Promise.resolve()
    const next = previous.then(() => this.whenOpen(spec.scope)).then(run)
    this.chains.set(spec.scope, next)
  }

  private async whenOpen(scope: MethodScope): Promise<void> {
    const hold = this.holds.get(scope)
    if (hold !== undefined && hold.count > 0) await hold.open
  }

  private settle(id: RpcId, entry: InFlight, body: { result: unknown } | { error: RpcErrorShape }): void {
    if (entry.answered) return
    entry.answered = true
    this.inFlight.delete(id)
    this.answer(id, entry.method, body)
  }

  private answer(id: RpcId, method: string, body: { result: unknown } | { error: RpcErrorShape }): void {
    this.writer.write({ jsonrpc: '2.0', id, ...body }, true)
    if (method !== 'initialize' || this.side !== 'runner' || this.initState !== 'pending') return
    if ('error' in body) {
      this.initState = 'none'
      const waiters = this.initWaiters
      this.initWaiters = []
      for (const waiter of waiters) waiter.fail()
      return
    }
    this.initState = 'done'
    this.writer.release()
    const waiters = this.initWaiters
    this.initWaiters = []
    for (const waiter of waiters) waiter.run()
  }

  private onResponseLine(value: Record<string, unknown>): void {
    const id = value.id
    if (!isRpcId(id)) {
      this.log(`runner wire: a response without a usable id (${JSON.stringify(id)}) was ignored`)
      return
    }
    const entry = this.pending.get(id)
    if (entry === undefined) {
      this.log(`runner wire: a response for ${id}, which is not pending, was ignored`)
      return
    }
    if (entry.method === 'initialize' && !isRecord(value.error) && (!isRecord(value.result) || value.result.protocol !== RUNNER_PROTOCOL)) {
      const received = isRecord(value.result) ? value.result.protocol : undefined
      this.failProtocol(refused(`runner protocol ${String(received)} is not supported; expected ${RUNNER_PROTOCOL}`, 'protocol', { protocol: RUNNER_PROTOCOL }))
      return
    }
    this.pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    if (isRecord(value.error)) {
      const code = typeof value.error.code === 'number' ? value.error.code : RPC_CANCELLED
      const message = typeof value.error.message === 'string' ? value.error.message : 'error'
      entry.reject(new RpcError(code, message, value.error.data))
      return
    }
    if (isMethodName(entry.method)) {
      const check = checkResult(entry.method, value.result)
      if (!check.ok) {
        this.log(`runner wire: the answer to ${entry.method} (${id}) is not the shape the table declares: ${JSON.stringify(check.issues)}`)
        entry.reject(new RpcError(RPC_INVALID_PARAMS, `the answer to ${entry.method} is not the shape the table declares`, { method: entry.method, issues: check.issues }))
        return
      }
      entry.resolve(check.value)
      return
    }
    entry.resolve(value.result)
  }
}

export function createPeer(opts: PeerOptions): Peer {
  return new Peer(opts)
}
