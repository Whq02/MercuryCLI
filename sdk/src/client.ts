/// <reference types="node" preserve="true" />
/// <reference lib="esnext.disposable" preserve="true" />
import { readLines, readText } from './framing.js'
import { executableOf } from './executable.js'
import { StructuredSchema, schemaObject, validateOutcome, type OutputSchema } from './structured.js'
import { serveTools, withTools, type ToolDefinition, type ToolServer } from './helpers.js'
import { capRows, endChild, missingCwd, track, unlimitedSignal } from './lifecycle.js'
import { spawn, type ChildProcess } from 'node:child_process'
import type { EffortLevel, PermissionMode } from './door.js'
import { MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryUsageError, MercuryWireError, type RunExit } from './errors.js'
import { inputRowOf, isMainThread, mainThreadStep, parseRow, turnOpened, type StreamRow } from './parse.js'
import type { InputBlock, InputRow, ModelUsageRow, PromptRow, ShellRow, NoteRow, OutcomeRow, SessionRow, TurnRow, Usage } from './rows.js'

export type ConfigLayer = 'user' | 'project' | 'local'

export interface RunOptions<T = unknown> {
  worktree?: boolean | string
  reasoningMode?: 'enabled' | 'adaptive' | 'disabled'
  briefFile?: string
  briefAddFile?: string
  debug?: boolean | string
  replayTo?: string
  restoreFiles?: string
  tools?: readonly ToolDefinition[]
  autoAllowTools?: boolean
  prompt?: string | readonly InputBlock[] | AsyncIterable<string | InputRow>
  input?: 'rows'
  agentDefs?: Record<string, unknown>
  maxTime?: string
  stdin?: string
  mercury?: string | readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  project?: string
  model?: string
  effort?: EffortLevel
  backupModel?: string
  agent?: string
  mode?: PermissionMode
  sovereign?: boolean
  allowSovereign?: boolean
  allowedTools?: readonly string[]
  blockTools?: readonly string[]
  toolset?: readonly string[]
  mcp?: readonly string[]
  onlyMcp?: boolean
  brief?: string
  briefAdd?: string
  schema?: OutputSchema<T>
  maxTurns?: number
  maxRows?: number
  budgetUsd?: number
  partial?: boolean
  config?: string | Record<string, unknown>
  configLayers?: readonly ConfigLayer[]
  extensions?: readonly string[]
  sessionId?: string
  title?: string
  resume?: string
  continue?: boolean
  fork?: boolean
  ephemeral?: boolean
  lean?: boolean
  advise?: boolean
  noCommands?: boolean
  providerPreview?: readonly string[]
  logFile?: string
  extraArgs?: readonly string[]
  signal?: AbortSignal
  onStderr?: (chunk: string) => void
}

export type RunArgv = { command: string; args: string[] }

export function argvOf(options: RunOptions, door: 'run' | 'runner' = 'run'): RunArgv {
  const [command, ...lead] = executableOf(options.mercury, options.env, options.cwd)
  if (command === undefined || command === '') throw new MercuryError('the mercury executable is empty', null)
  const args: string[] = [...lead]
  if (options.project !== undefined) args.push('--project', options.project)
  args.push(...(door === 'run' ? ['run', '--format', 'rows'] : ['runner']))
  const value = (flag: string, given: string | undefined): void => {
    if (given !== undefined) args.push(flag, given)
  }
  const flag = (name: string, given: boolean | undefined): void => {
    if (given === true) args.push(name)
  }
  const list = (name: string, given: readonly string[] | undefined): void => {
    for (const entry of given ?? []) {
      if (entry.startsWith('-')) throw new MercuryError(`error: option '${name}' argument '${entry}' is invalid.`, null)
      args.push(`${name}=${entry}`)
    }
  }
  const json = (given: string | Record<string, unknown> | undefined): string | undefined => (given === undefined ? undefined : typeof given === 'string' ? given : JSON.stringify(given))
  value('--model', options.model)
  value('--effort', options.effort)
  value('--backup-model', options.backupModel)
  value('--agent', options.agent)
  value('--agent-defs', json(options.agentDefs))
  value('--max-time', options.maxTime)
  value('--input', options.prompt !== undefined && typeof options.prompt !== 'string' ? 'rows' : options.input)
  value('--mode', options.mode)
  flag('--sovereign', options.sovereign)
  flag('--allow-sovereign', options.allowSovereign)
  list('--allowed-tools', options.allowedTools)
  list('--block-tools', options.blockTools)
  list('--toolset', options.toolset)
  list('--mcp', options.mcp)
  flag('--only-mcp', options.onlyMcp)
  value('--brief', options.brief)
  value('--brief-file', options.briefFile)
  value('--brief-add-file', options.briefAddFile)
  value('--reasoning-mode', options.reasoningMode)
  for (const [name, setting] of [['--worktree', options.worktree], ['--debug', options.debug]] as const) {
    if (setting === true) args.push(name)
    else if (typeof setting === 'string') args.push(name, setting)
  }
  value('--brief-add', options.briefAdd)
  value('--schema', options.schema === undefined ? undefined : JSON.stringify(schemaObject(options.schema, options.cwd)))
  value('--max-turns', options.maxTurns === undefined ? undefined : String(options.maxTurns))
  value('--budget', options.budgetUsd === undefined ? undefined : String(options.budgetUsd))
  flag('--partial', options.partial)
  value('--config', json(options.config))
  value('--config-layers', options.configLayers === undefined ? undefined : options.configLayers.join(','))
  for (const extension of options.extensions ?? []) args.push('--extension', extension)
  value('--session-id', options.sessionId)
  value('--title', options.title)
  value('--resume', options.resume)
  value('--replay-to', options.replayTo)
  value('--restore-files', options.restoreFiles)
  flag('--continue', options.continue)
  flag('--fork', options.fork)
  flag('--ephemeral', options.ephemeral)
  flag('--lean', options.lean)
  flag('--advise', options.advise)
  flag('--no-commands', options.noCommands)
  list('--provider-preview', options.providerPreview)
  value('--log-file', options.logFile)
  args.push(...(options.extraArgs ?? []))
  if (typeof options.prompt === 'string') args.push('--', options.prompt)
  return { command, args }
}

type RowListener<T extends StreamRow['type']> = (row: Extract<StreamRow, { type: T }>) => void
type Listener = (payload: never) => void

const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'] as const

export function interruptedOutcome(rows: readonly StreamRow[], startedAt: number, now = Date.now()): OutcomeRow {
  const opened = rows.filter((row): row is TurnRow => turnOpened(row) && isMainThread(row))
  const turn = opened.at(-1)
  const steps = rows.filter(mainThreadStep).filter(step => turn === undefined || step.seq > turn.seq)
  const zero = (): Usage => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 })
  const usage = zero()
  const models: Record<string, ModelUsageRow> = {}
  for (const step of steps) {
    const model = models[step.model] ?? (models[step.model] = { ...zero(), web_searches: 0 })
    for (const key of USAGE_KEYS) { usage[key] += step.usage[key]; model[key] += step.usage[key] }
    if (step.usage.reasoning_output_tokens !== undefined) {
      usage.reasoning_output_tokens = (usage.reasoning_output_tokens ?? 0) + step.usage.reasoning_output_tokens
      model.reasoning_output_tokens = (model.reasoning_output_tokens ?? 0) + step.usage.reasoning_output_tokens
    }
  }
  const last = rows.at(-1)
  return { type: 'outcome', seq: (last?.seq ?? 0) + 1, timestamp: new Date(now).toISOString(), session_id: last?.session_id ?? '', turn: turn?.turn ?? Math.max(1, opened.length), schema: 1, turn_id: turn?.turn_id ?? '', status: 'interrupted', error: { message: 'Interrupted', class: 'interrupt' }, steps: steps.length, wall_ms: Math.max(0, now - (turn === undefined ? startedAt : Date.parse(turn.timestamp))), usage, models, denials: [] }
}

export class MercuryRun<T = unknown> implements AsyncIterable<StreamRow> {
  command: string
  args: readonly string[]
  readonly rows: StreamRow[] = []
  readonly outcome: Promise<OutcomeRow<T>>
  readonly session: Promise<SessionRow>
  readonly exit: Promise<RunExit>
  readonly ready: Promise<void>
  child!: ChildProcess
  #tools: ToolServer | undefined

  #abortCleanup: (() => void) | undefined
  #streaming: boolean
  #listeners = new Map<string, Set<Listener>>()
  #stopTimer: ReturnType<typeof setTimeout> | undefined
  #abortRequested = false
  #interruptSent = false
  #startedAt = Date.now()
  #stderr = ''
  #settled = false
  #error: MercuryError | null = null
  #outcomeRow: OutcomeRow | null = null
  #sessionRow: SessionRow | null = null
  #spawnFailure: unknown = undefined
  #sent = 0
  #resolveOutcome!: (row: OutcomeRow<T>) => void
  #rejectOutcome!: (error: MercuryError) => void
  #resolveSession!: (row: SessionRow) => void
  #rejectSession!: (error: MercuryError) => void
  #resolveExit!: (exit: RunExit) => void
  #waiters: Array<{ resolve: (next: IteratorResult<StreamRow>) => void; reject: (error: MercuryError) => void }> = []
  #queue: StreamRow[] = []
  #done = false

  constructor(private options: RunOptions<T>) {
    if (options.schema !== undefined && !(options.schema instanceof StructuredSchema)) options = { ...options, schema: schemaObject(options.schema, options.cwd) }
    this.options = options
    if (options.prompt !== undefined && typeof options.prompt !== 'string') options = { ...options, input: 'rows' }
    if (options.input === 'rows' && options.stdin !== undefined) throw new MercuryError('stdin text cannot be combined with input rows', null)
    this.#streaming = options.input === 'rows'
    const { command, args } = argvOf(options)
    this.command = command
    this.args = args
    this.outcome = new Promise<OutcomeRow<T>>((resolve, reject) => {
      this.#resolveOutcome = resolve
      this.#rejectOutcome = reject
    })
    this.session = new Promise<SessionRow>((resolve, reject) => {
      this.#resolveSession = resolve
      this.#rejectSession = reject
    })
    this.exit = new Promise<RunExit>(resolve => {
      this.#resolveExit = resolve
    })
    this.outcome.catch(() => undefined)
    this.session.catch(() => undefined)
    if (options.tools?.length) {
      this.ready = serveTools(options.tools).then(server => {
        this.#tools = server
        this.#start(withTools(options, server))
      }).catch(async error => {
        this.#error = error instanceof MercuryError ? error : new MercuryError(String(error), null)
        await this.#settle(null, null)
        throw this.#error
      })
    } else {
      this.#start(options)
      this.ready = Promise.resolve()
    }
    this.ready.catch(() => undefined)
  }

  #start(options: RunOptions): void {
    const { command, args } = argvOf(options)
    this.command = command
    this.args = args
    const cwdProblem = missingCwd(options.cwd)
    this.#startedAt = Date.now()
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    track(this.child)
    readLines(this.child.stdout!, line => this.#line(line), error => this.#fatal(error))
    readText(this.child.stderr!, chunk => {
      this.#stderr += chunk
      this.#emit('stderr', chunk)
      options.onStderr?.(chunk)
    })
    this.child.stdin!.on('error', () => undefined)
    this.child.on('error', (error: unknown) => {
      this.#spawnFailure = cwdProblem ?? error
      if (this.child.pid === undefined) this.#settle(null, null)
    })
    this.child.on('close', (code, signal) => this.#settle(code, signal))
    if (options.stdin !== undefined) this.child.stdin!.write(options.stdin)
    if (options.input !== 'rows') this.child.stdin!.end()
    if (options.prompt !== undefined && typeof options.prompt !== 'string') void this.#feed(options.prompt)
    if (options.signal !== undefined) {
      unlimitedSignal(options.signal)
      if (options.signal.aborted) this.#abortRequested = true
      else {
        const abort = () => { if (this.#sessionRow) this.interrupt(); else this.#abortRequested = true }
        options.signal.addEventListener('abort', abort, { once: true })
        this.#abortCleanup = () => options.signal!.removeEventListener('abort', abort)
      }
    }
  }

  async #feed(prompt: readonly InputBlock[] | AsyncIterable<string | InputRow>): Promise<void> {
    try {
      if (Symbol.asyncIterator in prompt) {
        const iterator = prompt[Symbol.asyncIterator]()
        const ended = this.exit.then(() => ({ done: true as const, value: undefined }))
        let finished = false
        try {
          while (!this.#settled) {
            const next = await Promise.race([iterator.next(), ended])
            if (next.done) { finished = !this.#settled; break }
            await this.send(typeof next.value === 'string' ? { type: 'prompt', content: next.value } : next.value)
          }
        } finally {
          if (!finished && iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined)
        }
      } else await this.sendPrompt([...prompt])
      this.closeInput()
    } catch (error) { if (!this.#settled) this.#fatal(error instanceof MercuryError ? error : new MercuryError(String(error), null)) }
  }

  on<T extends StreamRow['type']>(type: T, listener: RowListener<T>): this
  on(type: 'row', listener: (row: StreamRow) => void): this
  on(type: 'stderr', listener: (chunk: string) => void): this
  on(type: 'error', listener: (error: MercuryError) => void): this
  on(type: 'end', listener: (exit: RunExit) => void): this
  on(type: string, listener: (payload: never) => void): this {
    let set = this.#listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(listener as Listener)
    return this
  }

  off(type: string, listener: (payload: never) => void): this {
    this.#listeners.get(type)?.delete(listener as Listener)
    return this
  }

  async send(row: InputRow): Promise<void> {
    await this.ready
    if (this.#settled || this.child.exitCode !== null || this.child.signalCode !== null || !this.#streaming || this.child.stdin!.writableEnded || this.child.stdin!.destroyed) return Promise.reject(new MercuryError('input rows is not open', null))
    const read = inputRowOf(row)
    if (!read.ok) return Promise.reject(new MercuryWireError(JSON.stringify(row), read.reason, read.type, read.issues, null))
    return new Promise((resolve, reject) => this.child.stdin!.write(JSON.stringify(row) + '\n', error => { if (error) reject(new MercuryError(error.message, null, { cause: error })); else { this.#sent++; resolve() } }))
  }

  sendPrompt(content: PromptRow['content'], options: Omit<PromptRow, 'type' | 'content'> = {}): Promise<void> { return this.send({ ...options, type: 'prompt', content }) }
  sendShell(command: string, options: Omit<ShellRow, 'type' | 'command'> = {}): Promise<void> { return this.send({ ...options, type: 'shell', command }) }
  sendNote(to: string, content: string, options: Omit<NoteRow, 'type' | 'to' | 'content'> = {}): Promise<void> { return this.send({ ...options, type: 'note', to, content }) }
  closeInput(): void { if (this.child) this.child.stdin!.end(); else void this.ready.then(() => this.child?.stdin?.end(), () => undefined) }

  interrupt(): boolean {
    this.#tools?.cancel()
    if (this.#settled) return false
    if (!this.child || this.#sessionRow === null) { this.#abortRequested = true; return true }
    const sent = this.child.kill('SIGINT')
    if (sent) this.#interruptSent = true
    return sent
  }

  terminate(): boolean {
    if (!this.child) { void this.ready.then(() => this.child?.kill('SIGTERM'), () => undefined); return true }
    return this.child.kill('SIGTERM')
  }

  kill(): boolean {
    if (!this.child) { void this.ready.then(() => this.child?.kill('SIGKILL'), () => undefined); return true }
    return this.child.kill('SIGKILL')
  }

  close(): Promise<void> { return this.ready.catch(() => undefined).then(() => this.child ? endChild(this.child, this.exit) : this.exit.then(() => undefined)) }
  clearRows(): void { this.rows.length = 0; this.#queue.length = 0 }
  async [Symbol.asyncDispose](): Promise<void> { await this.close() }

  get error(): MercuryError | null {
    return this.#error
  }

  get stderr(): string {
    return this.#stderr
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamRow> {
    return {
      next: (): Promise<IteratorResult<StreamRow>> => {
        const queued = this.#queue.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#done) return this.#endOfRows()
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
      },
      return: (): Promise<IteratorResult<StreamRow>> => Promise.resolve({ value: undefined, done: true }),
    }
  }

  #endOfRows(): Promise<IteratorResult<StreamRow>> {
    if (this.#error !== null) return Promise.reject(this.#error)
    return Promise.resolve({ value: undefined, done: true })
  }

  #emit(type: string, payload: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) (listener as (payload: unknown) => void)(payload)
  }

  #fatal(error: MercuryError): void {
    if (this.#error) return
    this.#error = error
    this.child.stdin!.end()
    this.terminate()
    this.#stopTimer = setTimeout(() => this.kill(), 1000)
    this.#stopTimer.unref()
  }

  #line(line: string): void {
    if (this.#error || line.trim() === '') return
    const read = parseRow(line)
    if (!read.ok) {
      this.#fatal(new MercuryWireError(line, read.reason, read.type, read.issues, null))
      return
    }
    this.#deliver(read.row)
  }

  #deliver(row: StreamRow): void {
    this.rows.push(row)
    capRows(this.rows, this.options.maxRows)
    if (row.type === 'session' && this.#sessionRow === null) {
      this.#sessionRow = row
      this.#resolveSession(row)
      if (this.#abortRequested) this.interrupt()
    }
    if (row.type === 'outcome') this.#outcomeRow = row
    this.#emit('row', row)
    this.#emit(row.type, row)
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter.resolve({ value: row, done: false })
    else { this.#queue.push(row); capRows(this.#queue, this.options.maxRows) }
  }

  async #settle(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#settled) return
    this.#settled = true
    await this.#tools?.close()
    this.#abortCleanup?.()
    clearTimeout(this.#stopTimer)
    const exit: RunExit = { code, signal, stderr: this.#stderr }
    if (this.#error === null && this.#outcomeRow === null && this.#spawnFailure === undefined && this.#interruptSent && (signal === 'SIGINT' || code === 130)) this.#deliver(interruptedOutcome(this.rows, this.#startedAt))
    if (this.#error === null) {
      if (this.#spawnFailure !== undefined && this.#outcomeRow === null) this.#error = new MercurySpawnError(this.command, this.#spawnFailure)
      else if (this.#outcomeRow !== null && this.#outcomeRow.status === 'refused') this.#error = new MercuryRefusal(this.#outcomeRow, exit)
      else if (this.#outcomeRow === null && code === 2) this.#error = new MercuryUsageError(exit)
      else if (this.#outcomeRow === null) this.#error = new MercuryExitError(exit, 'run', this.#streaming && this.#sent === 0 && this.rows.length === 0 ? 'no input row was sent before stdin was closed' : undefined)
    }
    let outcome: OutcomeRow<T> | undefined
    if (this.#error === null && this.#outcomeRow) {
      try { outcome = validateOutcome(this.#outcomeRow, this.options.schema, this.options.cwd) }
      catch (error) { this.#error = error instanceof MercuryError ? error : new MercuryError(String(error), exit) }
    }
    if (this.#error !== null) { this.#error.exit = exit; this.#emit('error', this.#error) }
    if (this.#error !== null) {
      this.#rejectOutcome(this.#error)
      if (this.#sessionRow === null) this.#rejectSession(this.#error)
    } else {
      this.#resolveOutcome(outcome!)
      if (this.#sessionRow === null) this.#rejectSession(new MercuryExitError(exit))
    }
    this.#done = true
    this.#resolveExit(exit)
    this.#emit('end', exit)
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error !== null) waiter.reject(this.#error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }
}

export function run<T = unknown>(options: RunOptions<T>): MercuryRun<T> {
  return new MercuryRun<T>(options)
}

export function warmOptions<T extends RunOptions>(options: T): T {
  return { ...options, env: { ...(options.env ?? process.env), MERCURY_CONCOURSE_WORKER: '1' } }
}
