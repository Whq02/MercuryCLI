/// <reference lib="esnext.disposable" preserve="true" />
import { spawn, type ChildProcess } from 'node:child_process'
import { readLines } from './framing.js'
import { endChild, missingCwd, track } from './lifecycle.js'
import { randomUUID } from 'node:crypto'
import { argvOf, checkpointOptions, type RunOptions } from './client.js'
import { MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryUsageError, MercuryWireError, type RunExit } from './errors.js'
import { inputRowOf, rowOf, type StreamRow } from './parse.js'
import type { InputRow, OutcomeRow, PromptRow, ShellRow, NoteRow } from './rows.js'
import { METHODS, RUNNER_PROTOCOL, RPC_REFUSED, type HostRequestName, type HostNotificationName, type RunnerRequestName, type MethodName, type ParamsOf, type ResultOf } from './wire.js'
import { validate } from './validate.js'
import { VERSION } from './version.js'
import { serveTools, withTools, type ToolServer } from './helpers.js'

export type RequestContext = { signal: AbortSignal; id: number }
export type HostHandlers = { [M in RunnerRequestName]?: (params: ParamsOf<M>, context: RequestContext) => ResultOf<M> | (keyof ResultOf<M> extends never ? void : never) | Promise<ResultOf<M> | (keyof ResultOf<M> extends never ? void : never)> }
export interface ConnectOptions extends Omit<RunOptions, 'prompt' | 'stdin' | 'input' | 'signal'> {
  warm?: boolean
  host?: { name: string; version: string }
  capabilities?: Partial<ParamsOf<'initialize'>['capabilities']>
  handlers?: HostHandlers
  onPermissionRequest?: HostHandlers['permission/request']
  onElicitation?: HostHandlers['elicitation/request']
  onReadTextFile?: HostHandlers['fs/read_text_file']
  onWriteTextFile?: HostHandlers['fs/write_text_file']
}
export type RequestOptions = { signal?: AbortSignal; deadlineMs?: number | null }
export type PromptOptions = { signal?: AbortSignal }
type Pending = { method: HostRequestName; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }

export class MercurySession implements AsyncIterable<StreamRow> {
  readonly child: ChildProcess
  readonly exit: Promise<RunExit>
  readonly rows: StreamRow[] = []
  initialized!: ResultOf<'initialize'>
  stderr = ''
  lastPromptId: string | undefined
  #pending = new Map<number, Pending>()
  #asks = new Map<number, AbortController>()
  #listeners = new Map<string, Set<(value: any) => void>>()
  #queue: StreamRow[] = []
  #waiters: Array<{ resolve: (v: IteratorResult<StreamRow>) => void; reject: (e: Error) => void }> = []
  #closed: Error | null = null
  #next = 0
  #stopTimer: ReturnType<typeof setTimeout> | undefined
  #handlers: HostHandlers
  #prompting = false
  #promptTurns = new Map<string, string | undefined>()
  #correlatedTurns = false
  #closing = false
  #normalEnd = false
  #promptReject: ((error: Error) => void) | undefined

  constructor(options: ConnectOptions = {}, private readonly toolServer?: ToolServer) {
    if (options.warm && (options.sessionId || options.resume || options.continue || options.fork)) throw new MercuryError('warm cannot be combined with session identity options', null)
    options = checkpointOptions({ ...options, checkpointFiles: options.checkpointFiles ?? true }, options.warm)
    const argv = argvOf({ ...options, partial: false, prompt: undefined, input: undefined, stdin: undefined })
    const lead = Array.isArray(options.mercury) ? options.mercury.length - 1 : 0
    const door = lead + (options.project !== undefined ? 2 : 0)
    argv.args.splice(door, 3, 'runner')
    this.#handlers = { ...options.handlers }
    if (options.onPermissionRequest) this.#handlers['permission/request'] = options.onPermissionRequest
    if (options.onElicitation) this.#handlers['elicitation/request'] = options.onElicitation
    if (options.onReadTextFile) this.#handlers['fs/read_text_file'] = options.onReadTextFile
    if (options.onWriteTextFile) this.#handlers['fs/write_text_file'] = options.onWriteTextFile
    const cwdProblem = missingCwd(options.cwd)
    this.child = spawn(argv.command, argv.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'pipe', windowsHide: true })
    track(this.child)
    this.child.stderr!.setEncoding('utf8').on('data', (s: string) => { this.stderr += s })
    this.child.stdin!.on('error', e => this.#fail(new MercuryError(e.message, null, { cause: e })))
    this.child.on('error', e => this.#fail(new MercurySpawnError(argv.command, cwdProblem ?? e)))
    readLines(this.child.stdout!, line => { if (!this.#closed) void this.#read(line).catch(e => this.#fail(e)) }, error => this.#fail(error))
    this.exit = new Promise(resolve => this.child.once('close', async (code, signal) => {
      const exit = { code, signal, stderr: this.stderr }
      this.#fail(code === 2 && (this.initialized as ResultOf<'initialize'> | undefined) === undefined ? new MercuryUsageError(exit, 'runner') : new MercuryExitError(exit, 'runner'), this.#closing)
      clearTimeout(this.#stopTimer)
      await this.toolServer?.close()
      resolve(exit)
    }))
  }

  on<T extends StreamRow['type']>(type: T, listener: (row: Extract<StreamRow, { type: T }>) => void): this
  on(type: 'row', listener: (row: StreamRow) => void): this
  on(type: 'error', listener: (error: MercuryError) => void): this
  on(type: 'notification', listener: (message: { method: string; params: unknown }) => void): this
  on(type: string, listener: (value: any) => void): this {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type)!.add(listener)
    return this
  }
  off(type: string, listener: (value: never) => void): this { this.#listeners.get(type)?.delete(listener as (value: unknown) => void); return this }
  #emit(type: string, value: unknown): void { for (const fn of this.#listeners.get(type) ?? []) fn(value) }
  #write(value: unknown): void {
    if (this.#closed) throw this.#closed
    this.child.stdin!.write(JSON.stringify(value) + '\n')
  }

  request<M extends HostRequestName>(method: M, params: ParamsOf<M>, options: RequestOptions = {}): Promise<ResultOf<M>> {
    if (this.#closed) return Promise.reject(this.#closed)
    const spec = METHODS[method]
    if (!spec || spec.kind !== 'request' || spec.from === 'runner') return Promise.reject(new MercuryError(`not a host request: ${method}`, null))
    const input = method === 'queue/add' ? inputRowOf(params) : undefined
    if (input && !input.ok) return Promise.reject(new MercuryWireError(JSON.stringify(params), input.reason, input.type, input.issues, null))
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
    if (line.trim() === '') return
    let msg: any
    try { msg = JSON.parse(line) } catch { throw new MercuryWireError(line, 'not_json', undefined, [], null) }
    if (!msg || msg.jsonrpc !== '2.0') throw new MercuryWireError(line, 'invalid', undefined, [], null)
    if ('method' in msg && typeof msg.method !== 'string') throw new MercuryWireError(line, 'invalid', undefined, [], null)
    if (typeof msg.method !== 'string') {
      if (msg.id === null && !('result' in msg) && msg.error && Number.isInteger(msg.error.code) && typeof msg.error.message === 'string') {
        const error = new MercuryError(msg.error.message, null)
        error.code = msg.error.code; error.data = msg.error.data
        throw error
      }
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
    if (msg.method === '$/cancel_request') { this.#asks.get(msg.params?.request_id)?.abort(msg.params?.reason); return }
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
    if (!graceful) {
      this.child.stdin!.end()
      this.child.kill('SIGTERM')
      this.#stopTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000)
      this.#stopTimer.unref()
      this.#emit('error', error)
    }
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
  sendShell(command: string, options: Omit<ShellRow, 'type' | 'command'> = {}) { return this.send({ ...options, type: 'shell', command }) }
  sendNote(to: string, content: string, options: Omit<NoteRow, 'type' | 'to' | 'content'> = {}) { return this.send({ ...options, type: 'note', to, content }) }
  withdraw(id: string) { return this.request('queue/withdraw', { id }) }
  interrupt(options: ParamsOf<'turn/interrupt'> = {}) { this.toolServer?.cancel(); return this.request('turn/interrupt', options) }
  facts() { return this.request('session/facts', {}) }
  setModel(model: string) { return this.request('session/set_model', { model }) }
  setEffort(effort: string) { return this.request('session/set_effort', { effort }) }
  setMode(mode: string) { return this.request('session/set_mode', { mode }) }
  setKit(kit: unknown) { return this.request('session/set_kit', { kit }) }
  rewind(options: ParamsOf<'session/rewind'>) { return this.request('session/rewind', options) }
  stopAgent(agent_id: string, note?: string) { return this.request('agent/stop', { agent_id, note }) }
  resumeAgent(agent_id: string, note?: string) { return this.request('agent/resume', { agent_id, note }) }
  claim(params: ParamsOf<'session/claim'>) { return this.request('session/claim', params) }

  async prompt(content: PromptRow['content'], options: PromptOptions = {}): Promise<OutcomeRow> {
    if (this.#prompting) throw new MercuryError('prompt already pending; use sendPrompt for mid-turn input', null)
    if (options.signal?.aborted) throw new MercuryError('prompt: cancelled', null)
    this.#prompting = true
    const id = randomUUID()
    this.lastPromptId = id
    let done!: (row: OutcomeRow) => void
    let fail!: (error: Error) => void
    const result = new Promise<OutcomeRow>((resolve, reject) => { done = row => { if (row.parent_call_id === undefined && (this.#correlatedTurns ? this.#promptTurns.get(id) === row.turn_id : this.#promptTurns.keys().next().value === id)) resolve(row) }; fail = reject })
    result.catch(() => undefined)
    const abort = () => fail(new MercuryError('prompt: cancelled', null))
    options.signal?.addEventListener('abort', abort, { once: true })
    this.#promptReject = fail
    this.on('outcome', done)
    try {
      const receipt = await this.sendPrompt(content, { id })
      if (!receipt.accepted) throw new MercuryError('prompt was not accepted', null)
      const row = await result
      if (row.status === 'refused') throw new MercuryRefusal(row, null)
      return row
    } finally { options.signal?.removeEventListener('abort', abort); this.off('outcome', done); this.#promptReject = undefined; this.#prompting = false }
  }

  close(): Promise<void> {
    this.#closing = true
    return endChild(this.child, this.exit)
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close() }
}

export async function connect(options: ConnectOptions = {}): Promise<MercurySession> {
  const tools = options.tools?.length ? await serveTools(options.tools) : undefined
  let session: MercurySession
  try { session = new MercurySession(tools ? withTools(options, tools) : options, tools) }
  catch (error) { await tools?.close(); throw error }
  try {
    session.initialized = await session.request('initialize', {
      protocol: RUNNER_PROTOCOL, host: options.host ?? { name: 'mercury-cli-sdk', version: VERSION },
      capabilities: { holds_asks: Boolean(options.onPermissionRequest || options.handlers?.['permission/request']), elicitation: Boolean(options.onElicitation || options.handlers?.['elicitation/request']), partial_rows: options.partial ?? false, fs_read_text_file: Boolean(options.onReadTextFile || options.handlers?.['fs/read_text_file']), fs_write_text_file: Boolean(options.onWriteTextFile || options.handlers?.['fs/write_text_file']), terminal: ['terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release'].every(method => Boolean(options.handlers?.[method as RunnerRequestName])), ...options.capabilities },
    })
    return session
  } catch (error) { await session.close(); throw error }
}

export function prewarm(options: Omit<ConnectOptions, 'warm' | 'sessionId' | 'resume' | 'continue' | 'fork'> = {}): Promise<MercurySession> {
  return connect({ ...options, warm: true })
}
