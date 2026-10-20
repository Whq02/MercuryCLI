/// <reference lib="esnext.disposable" preserve="true" />
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { argvOf, type RunOptions } from './client.js'
import { MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryWireError, type RunExit } from './errors.js'
import { rowOf, type StreamRow } from './parse.js'
import type { InputRow, OutcomeRow, PromptRow } from './rows.js'
import { METHODS, RUNNER_PROTOCOL, RPC_REFUSED, type HostRequestName, type HostNotificationName, type RunnerRequestName, type MethodName, type ParamsOf, type ResultOf } from './wire.js'
import { validate } from './validate.js'

export type RequestContext = { signal: AbortSignal; id: number }
export type HostHandlers = { [M in RunnerRequestName]?: (params: ParamsOf<M>, context: RequestContext) => ResultOf<M> | (keyof ResultOf<M> extends never ? void : never) | Promise<ResultOf<M> | (keyof ResultOf<M> extends never ? void : never)> }
export interface ConnectOptions extends Omit<RunOptions, 'prompt' | 'stdin' | 'input' | 'signal'> {
  host?: { name: string; version: string }
  capabilities?: Partial<ParamsOf<'initialize'>['capabilities']>
  handlers?: HostHandlers
  onPermissionRequest?: HostHandlers['permission/request']
  onElicitation?: HostHandlers['elicitation/request']
}
export type RequestOptions = { signal?: AbortSignal; deadlineMs?: number | null }
type Pending = { method: HostRequestName; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }

export class MercurySession implements AsyncIterable<StreamRow> {
  readonly child: ChildProcess
  readonly exit: Promise<RunExit>
  readonly rows: StreamRow[] = []
  initialized!: ResultOf<'initialize'>
  stderr = ''
  #pending = new Map<number, Pending>()
  #asks = new Map<number, AbortController>()
  #listeners = new Map<string, Set<(value: any) => void>>()
  #queue: StreamRow[] = []
  #waiters: Array<{ resolve: (v: IteratorResult<StreamRow>) => void; reject: (e: Error) => void }> = []
  #closed: Error | null = null
  #next = 0
  #handlers: HostHandlers
  #prompting = false
  #promptTurns = new Map<string, string | undefined>()
  #correlatedTurns = false
  #closing = false
  #normalEnd = false
  #promptReject: ((error: Error) => void) | undefined

  constructor(options: ConnectOptions = {}) {
    const argv = argvOf({ ...options, partial: false, prompt: undefined, input: undefined, stdin: undefined })
    const lead = Array.isArray(options.mercury) ? options.mercury.length - 1 : 0
    const door = lead + (options.project !== undefined ? 2 : 0)
    argv.args.splice(door, 3, 'runner')
    this.#handlers = { ...options.handlers }
    if (options.onPermissionRequest) this.#handlers['permission/request'] = options.onPermissionRequest
    if (options.onElicitation) this.#handlers['elicitation/request'] = options.onElicitation
    this.child = spawn(argv.command, argv.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'pipe', windowsHide: true })
    this.child.stderr!.setEncoding('utf8').on('data', (s: string) => { this.stderr += s })
    this.child.stdin!.on('error', e => this.#fail(new MercuryError(e.message, null, { cause: e })))
    this.child.on('error', e => this.#fail(new MercurySpawnError(argv.command, e)))
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    lines.on('line', line => { void this.#read(line).catch(e => this.#fail(e)) })
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => {
      const exit = { code, signal, stderr: this.stderr }
      this.#fail(new MercuryExitError(exit), this.#closing)
      lines.close()
      resolve(exit)
    }))
  }

  on<T extends StreamRow['type']>(type: T, listener: (row: Extract<StreamRow, { type: T }>) => void): this
  on(type: 'row', listener: (row: StreamRow) => void): this
  on(type: 'error', listener: (error: Error) => void): this
  on(type: 'notification', listener: (message: { method: string; params: unknown }) => void): this
  on(type: string, listener: (value: any) => void): this {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type)!.add(listener)
    return this
  }
  off(type: string, listener: (value: any) => void): this { this.#listeners.get(type)?.delete(listener); return this }
  #emit(type: string, value: unknown): void { for (const fn of this.#listeners.get(type) ?? []) fn(value) }
  #write(value: unknown): void {
    if (this.#closed) throw this.#closed
    this.child.stdin!.write(JSON.stringify(value) + '\n')
  }

  request<M extends HostRequestName>(method: M, params: ParamsOf<M>, options: RequestOptions = {}): Promise<ResultOf<M>> {
    if (this.#closed) return Promise.reject(this.#closed)
    const spec = METHODS[method]
    if (!spec || spec.kind !== 'request' || spec.from === 'runner') return Promise.reject(new MercuryError(`not a host request: ${method}`, null))
    const issues = validate(spec.params, params)
    if (issues.length) return Promise.reject(new MercuryWireError(JSON.stringify(params), 'invalid', method, issues, null))
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancel = (message: string) => {
        if (!this.#pending.delete(id)) return
        cleanup()
        try { this.notify('$/cancel_request', { request_id: id, reason: message }) } catch {}
        reject(new MercuryError(message, null))
      }
      const abort = () => cancel(`${method}: cancelled`)
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, cleanup })
      const ms = options.deadlineMs === undefined ? spec.deadlineMs : options.deadlineMs
      if (ms !== null) timer = setTimeout(() => cancel(`${method}: no answer within ${ms} ms`), ms)
      if (options.signal?.aborted) { abort(); return }
      options.signal?.addEventListener('abort', abort, { once: true })
      try { this.#write({ jsonrpc: '2.0', id, method, params }) } catch (error) { this.#pending.delete(id); cleanup(); reject(error) }
    })
  }

  notify<M extends HostNotificationName>(method: M, params: ParamsOf<M>): void {
    const spec = METHODS[method]
    if (!spec || spec.kind !== 'notification' || spec.from === 'runner') throw new MercuryError(`not a host notification: ${method}`, null)
    const issues = validate(spec.params, params)
    if (issues.length) throw new MercuryWireError(JSON.stringify(params), 'invalid', method, issues, null)
    this.#write({ jsonrpc: '2.0', method, params })
  }

  async #read(line: string): Promise<void> {
    let msg: any
    try { msg = JSON.parse(line) } catch { throw new MercuryWireError(line, 'not_json', undefined, [], null) }
    if (!msg || msg.jsonrpc !== '2.0') throw new MercuryWireError(line, 'invalid', undefined, [], null)
    if (typeof msg.method !== 'string') {
      if (!Number.isInteger(msg.id) || msg.id <= 0 || ('result' in msg) === ('error' in msg)) throw new MercuryWireError(line, 'invalid', undefined, [], null)
      if ('error' in msg && (!msg.error || typeof msg.error.message !== 'string' || !Number.isInteger(msg.error.code))) throw new MercuryWireError(line, 'invalid', undefined, [], null)
      const pending = this.#pending.get(msg.id)
      if (!pending) return
      this.#pending.delete(msg.id); pending.cleanup()
      if (msg.error) {
        const e = msg.error.code === RPC_REFUSED ? new MercuryRefusal(null, null, msg.error) : new MercuryError(msg.error.message, null)
        e.code = msg.error.code; e.data = msg.error.data
        pending.reject(e)
      } else {
        const issues = validate(METHODS[pending.method].result, msg.result)
        if (issues.length) pending.reject(new MercuryWireError(line, 'invalid', pending.method, issues, null))
        else pending.resolve(msg.result)
      }
      return
    }
    if (msg.method === '$/cancel_request') { this.#asks.get(msg.params?.request_id)?.abort(); return }
    if (msg.id === undefined) {
      if (msg.method === 'row') {
        const read = rowOf(msg.params)
        if (!read.ok) throw new MercuryWireError(line, read.reason, read.type, read.issues, null)
        this.rows.push(read.row)
        const waiter = this.#waiters.shift()
        if (waiter) waiter.resolve({ value: read.row, done: false }); else this.#queue.push(read.row)
        const row = read.row
        if (row.type === 'turn' && row.parent_call_id === undefined && row.message_ids !== undefined) {
          this.#correlatedTurns = true
          for (const id of row.message_ids) if (this.#promptTurns.has(id)) this.#promptTurns.set(id, row.turn_id)
        }
        this.#emit('row', row); this.#emit(row.type, row)
        if (row.type === 'outcome' && row.parent_call_id === undefined) {
          if (this.#correlatedTurns) { for (const [id, turn] of this.#promptTurns) if (turn === row.turn_id) this.#promptTurns.delete(id) }
          else { const id = this.#promptTurns.keys().next().value; if (id !== undefined) this.#promptTurns.delete(id) }
        }
      } else this.#emit('notification', { method: msg.method, params: msg.params })
      return
    }
    if (!Number.isInteger(msg.id) || msg.id <= 0) throw new MercuryWireError(line, 'invalid', msg.method, [], null)
    const method = msg.method as RunnerRequestName
    const spec = METHODS[method as MethodName]
    const controller = new AbortController()
    this.#asks.set(msg.id, controller)
    try {
      if (!spec || spec.kind !== 'request' || spec.from === 'host') { this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown host method ${method}` } }); return }
      const issues = validate(spec.params, msg.params)
      if (issues.length) { this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'invalid request params', data: issues } }); return }
      const handler = this.#handlers[method] as ((p: unknown, ctx: RequestContext) => unknown) | undefined
      if (!handler && method !== 'permission/request' && method !== 'elicitation/request') { this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no handler for ${method}` } }); return }
      let result = handler ? await handler(msg.params, { signal: controller.signal, id: msg.id }) : method === 'permission/request' ? { outcome: 'deny', message: 'No permission handler installed' } : method === 'elicitation/request' ? { action: 'decline' } : undefined
      if (controller.signal.aborted) return
      if (result === undefined && validate(spec.result, {}).length === 0) result = {}
      const invalid = validate(spec.result, result)
      if (invalid.length) throw new Error(`invalid host answer: ${JSON.stringify(invalid)}`)
      this.#write({ jsonrpc: '2.0', id: msg.id, result })
    } catch (error) {
      if (!controller.signal.aborted && !this.#closed) this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    } finally { this.#asks.delete(msg.id) }
  }

  #fail(error: Error, graceful = false): void {
    if (this.#closed) return
    this.#closed = error
    this.#normalEnd = graceful
    this.#promptReject?.(error)
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error) }
    this.#pending.clear()
    for (const ask of this.#asks.values()) ask.abort()
    for (const waiter of this.#waiters.splice(0)) { if (graceful) waiter.resolve({ value: undefined, done: true }); else waiter.reject(error) }
    if (!graceful) this.#emit('error', error)
  }
  [Symbol.asyncIterator](): AsyncIterator<StreamRow> {
    return { next: () => {
      const row = this.#queue.shift()
      if (row) return Promise.resolve({ value: row, done: false })
      if (this.#closed) return this.#normalEnd ? Promise.resolve({ value: undefined, done: true }) : Promise.reject(this.#closed)
      return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
    } }
  }
  async send(row: InputRow) {
    if (row.type !== 'prompt') return this.request('queue/add', row)
    const id = row.id ?? randomUUID()
    this.#promptTurns.set(id, undefined)
    try {
      const receipt = await this.request('queue/add', { ...row, id })
      if (!receipt.accepted) this.#promptTurns.delete(id)
      return receipt
    } catch (error) {
      if (error instanceof MercuryRefusal || error instanceof MercuryWireError) this.#promptTurns.delete(id)
      throw error
    }
  }
  sendPrompt(content: PromptRow['content'], options: Omit<PromptRow, 'type' | 'content'> = {}) { return this.send({ ...options, type: 'prompt', content }) }
  sendShell(command: string) { return this.send({ type: 'shell', command }) }
  sendNote(to: string, content: string) { return this.send({ type: 'note', to, content }) }
  withdraw(id: string) { return this.request('queue/withdraw', { id }) }
  interrupt(options: ParamsOf<'turn/interrupt'> = {}) { return this.request('turn/interrupt', options) }
  facts() { return this.request('session/facts', {}) }
  setModel(model: string) { return this.request('session/set_model', { model }) }
  setEffort(effort: string) { return this.request('session/set_effort', { effort }) }
  setMode(mode: string) { return this.request('session/set_mode', { mode }) }
  setKit(kit: unknown) { return this.request('session/set_kit', { kit }) }
  rewind(options: ParamsOf<'session/rewind'>) { return this.request('session/rewind', options) }
  stopAgent(agent_id: string, note?: string) { return this.request('agent/stop', { agent_id, note }) }
  resumeAgent(agent_id: string, note?: string) { return this.request('agent/resume', { agent_id, note }) }
  claim(params: ParamsOf<'session/claim'>) { return this.request('session/claim', params) }

  async prompt(content: PromptRow['content']): Promise<OutcomeRow> {
    if (this.#prompting) throw new MercuryError('prompt already pending; use sendPrompt for mid-turn input', null)
    this.#prompting = true
    const id = randomUUID()
    let done!: (row: OutcomeRow) => void
    let fail!: (error: Error) => void
    const result = new Promise<OutcomeRow>((resolve, reject) => { done = row => { if (row.parent_call_id === undefined && (this.#correlatedTurns ? this.#promptTurns.get(id) === row.turn_id : this.#promptTurns.keys().next().value === id)) resolve(row) }; fail = reject })
    result.catch(() => undefined)
    this.#promptReject = fail
    this.on('outcome', done)
    try {
      const receipt = await this.sendPrompt(content, { id })
      if (!receipt.accepted) throw new MercuryError('prompt was not accepted', null)
      const row = await result
      if (row.status === 'refused') throw new MercuryRefusal(row, null)
      return row
    } finally { this.off('outcome', done); this.#promptReject = undefined; this.#prompting = false }
  }

  async close(): Promise<void> {
    this.#closing = true
    this.child.stdin!.end()
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 5000)
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 10000)
    try { await this.exit } finally { clearTimeout(terminate); clearTimeout(kill) }
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close() }
}

export async function connect(options: ConnectOptions = {}): Promise<MercurySession> {
  const session = new MercurySession(options)
  try {
    session.initialized = await session.request('initialize', {
      protocol: RUNNER_PROTOCOL, host: options.host ?? { name: 'mercury-cli-sdk', version: '0.1.0' },
      capabilities: { holds_asks: Boolean(options.onPermissionRequest || options.handlers?.['permission/request']), elicitation: Boolean(options.onElicitation || options.handlers?.['elicitation/request']), partial_rows: options.partial ?? false, ...options.capabilities },
    })
    return session
  } catch (error) { await session.close(); throw error }
}
