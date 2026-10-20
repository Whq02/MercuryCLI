import { spawn, type ChildProcess } from 'node:child_process'
import type { EffortLevel, PermissionMode } from './door.js'
import { MercuryError, MercuryExitError, MercuryRefusal, MercurySpawnError, MercuryUsageError, MercuryWireError, type RunExit } from './errors.js'
import { inputRowOf, parseRow, type StreamRow } from './parse.js'
import type { InputRow, PromptRow, ShellRow, NoteRow, OutcomeRow, SessionRow } from './rows.js'

export type ConfigLayer = 'user' | 'project' | 'local'

export interface RunOptions {
  prompt?: string
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
  schema?: string | Record<string, unknown>
  maxTurns?: number
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
}

export type RunArgv = { command: string; args: string[] }

const DEFAULT_COMMAND = 'mercury'

export function argvOf(options: RunOptions): RunArgv {
  const executable = options.mercury ?? DEFAULT_COMMAND
  const [command, ...lead] = typeof executable === 'string' ? [executable] : [...executable]
  if (command === undefined || command === '') throw new MercuryError('the mercury executable is empty', null)
  const args: string[] = [...lead]
  if (options.project !== undefined) args.push('--project', options.project)
  args.push('run', '--format', 'rows')
  const value = (flag: string, given: string | undefined): void => {
    if (given !== undefined) args.push(flag, given)
  }
  const flag = (name: string, given: boolean | undefined): void => {
    if (given === true) args.push(name)
  }
  const list = (name: string, given: readonly string[] | undefined): void => {
    if (given !== undefined && given.length > 0) args.push(name, ...given)
  }
  const json = (given: string | Record<string, unknown> | undefined): string | undefined => (given === undefined ? undefined : typeof given === 'string' ? given : JSON.stringify(given))
  value('--model', options.model)
  value('--effort', options.effort)
  value('--backup-model', options.backupModel)
  value('--agent', options.agent)
  value('--agent-defs', json(options.agentDefs))
  value('--max-time', options.maxTime)
  value('--input', options.input)
  value('--mode', options.mode)
  flag('--sovereign', options.sovereign)
  flag('--allow-sovereign', options.allowSovereign)
  list('--allowed-tools', options.allowedTools)
  list('--block-tools', options.blockTools)
  list('--toolset', options.toolset)
  list('--mcp', options.mcp)
  flag('--only-mcp', options.onlyMcp)
  value('--brief', options.brief)
  value('--brief-add', options.briefAdd)
  value('--schema', json(options.schema))
  value('--max-turns', options.maxTurns === undefined ? undefined : String(options.maxTurns))
  value('--budget', options.budgetUsd === undefined ? undefined : String(options.budgetUsd))
  flag('--partial', options.partial)
  value('--config', json(options.config))
  value('--config-layers', options.configLayers === undefined ? undefined : options.configLayers.join(','))
  for (const extension of options.extensions ?? []) args.push('--extension', extension)
  value('--session-id', options.sessionId)
  value('--title', options.title)
  value('--resume', options.resume)
  flag('--continue', options.continue)
  flag('--fork', options.fork)
  flag('--ephemeral', options.ephemeral)
  flag('--lean', options.lean)
  flag('--advise', options.advise)
  flag('--no-commands', options.noCommands)
  list('--provider-preview', options.providerPreview)
  value('--log-file', options.logFile)
  args.push(...(options.extraArgs ?? []))
  if (options.prompt !== undefined) args.push('--', options.prompt)
  return { command, args }
}

type RowListener<T extends StreamRow['type']> = (row: Extract<StreamRow, { type: T }>) => void
type Listener = (payload: never) => void

export class MercuryRun implements AsyncIterable<StreamRow> {
  readonly command: string
  readonly args: readonly string[]
  readonly rows: StreamRow[] = []
  readonly outcome: Promise<OutcomeRow>
  readonly session: Promise<SessionRow>
  readonly exit: Promise<RunExit>
  readonly child: ChildProcess

  #abortCleanup: (() => void) | undefined
  #streaming: boolean
  #listeners = new Map<string, Set<Listener>>()
  #buffer = ''
  #stderr = ''
  #settled = false
  #error: MercuryError | null = null
  #outcomeRow: OutcomeRow | null = null
  #sessionRow: SessionRow | null = null
  #spawnFailure: unknown = undefined
  #resolveOutcome!: (row: OutcomeRow) => void
  #rejectOutcome!: (error: MercuryError) => void
  #resolveSession!: (row: SessionRow) => void
  #rejectSession!: (error: MercuryError) => void
  #resolveExit!: (exit: RunExit) => void
  #waiters: Array<{ resolve: (next: IteratorResult<StreamRow>) => void; reject: (error: MercuryError) => void }> = []
  #queue: StreamRow[] = []
  #done = false

  constructor(options: RunOptions) {
    if (options.input === 'rows' && options.stdin !== undefined) throw new MercuryError('stdin text cannot be combined with input rows', null)
    this.#streaming = options.input === 'rows'
    const { command, args } = argvOf(options)
    this.command = command
    this.args = args
    this.outcome = new Promise<OutcomeRow>((resolve, reject) => {
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
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout!.setEncoding('utf8')
    this.child.stderr!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => this.#feed(chunk))
    this.child.stderr!.on('data', (chunk: string) => {
      this.#stderr += chunk
    })
    this.child.stdin!.on('error', () => undefined)
    this.child.on('error', (error: unknown) => {
      this.#spawnFailure = error
      if (this.child.pid === undefined) this.#settle(null, null)
    })
    this.child.on('close', (code, signal) => this.#settle(code, signal))
    if (options.stdin !== undefined) this.child.stdin!.write(options.stdin)
    if (options.input !== 'rows') this.child.stdin!.end()
    if (options.signal !== undefined) {
      if (options.signal.aborted) this.interrupt()
      else {
        const abort = () => { this.interrupt() }
        options.signal.addEventListener('abort', abort, { once: true })
        this.#abortCleanup = () => options.signal!.removeEventListener('abort', abort)
      }
    }
  }

  on<T extends StreamRow['type']>(type: T, listener: RowListener<T>): this
  on(type: 'row', listener: (row: StreamRow) => void): this
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

  send(row: InputRow): Promise<void> {
    if (!this.#streaming || this.child.stdin!.writableEnded) return Promise.reject(new MercuryError('input rows is not open', null))
    const read = inputRowOf(row)
    if (!read.ok) return Promise.reject(new MercuryWireError(JSON.stringify(row), read.reason, read.type, read.issues, null))
    return new Promise((resolve, reject) => this.child.stdin!.write(JSON.stringify(row) + '\n', error => error ? reject(new MercuryError(error.message, null, { cause: error })) : resolve()))
  }

  sendPrompt(content: PromptRow['content'], options: Omit<PromptRow, 'type' | 'content'> = {}): Promise<void> { return this.send({ ...options, type: 'prompt', content }) }
  sendShell(command: string, options: Omit<ShellRow, 'type' | 'command'> = {}): Promise<void> { return this.send({ ...options, type: 'shell', command }) }
  sendNote(to: string, content: string, options: Omit<NoteRow, 'type' | 'to' | 'content'> = {}): Promise<void> { return this.send({ ...options, type: 'note', to, content }) }
  closeInput(): void { this.child.stdin!.end() }

  interrupt(): boolean {
    return this.child.kill('SIGINT')
  }

  terminate(): boolean {
    return this.child.kill('SIGTERM')
  }

  kill(): boolean {
    return this.child.kill('SIGKILL')
  }

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

  #feed(chunk: string): void {
    this.#buffer += chunk
    let newline: number
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      this.#line(line)
    }
  }

  #line(line: string): void {
    if (line.trim() === '') return
    const read = parseRow(line)
    if (!read.ok) {
      if (this.#error === null) {
        this.#error = new MercuryWireError(line, read.reason, read.type, read.issues, null)
        this.#emit('error', this.#error)
      }
      return
    }
    const row = read.row
    this.rows.push(row)
    if (row.type === 'session' && this.#sessionRow === null) {
      this.#sessionRow = row
      this.#resolveSession(row)
    }
    if (row.type === 'outcome') this.#outcomeRow = row
    this.#emit('row', row)
    this.#emit(row.type, row)
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter.resolve({ value: row, done: false })
    else this.#queue.push(row)
  }

  #settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#settled) return
    this.#settled = true
    this.#abortCleanup?.()
    if (this.#buffer.trim() !== '') this.#line(this.#buffer)
    this.#buffer = ''
    const exit: RunExit = { code, signal, stderr: this.#stderr }
    if (this.#error === null) {
      if (this.#spawnFailure !== undefined && this.#outcomeRow === null) this.#error = new MercurySpawnError(this.command, this.#spawnFailure)
      else if (this.#outcomeRow !== null && this.#outcomeRow.status === 'refused') this.#error = new MercuryRefusal(this.#outcomeRow, exit)
      else if (this.#outcomeRow === null && code === 2) this.#error = new MercuryUsageError(exit)
      else if (this.#outcomeRow === null) this.#error = new MercuryExitError(exit)
      if (this.#error !== null) this.#emit('error', this.#error)
    } else if (this.#error instanceof MercuryWireError) {
      this.#error = new MercuryWireError(this.#error.line, this.#error.reason, this.#error.rowType, this.#error.issues, exit)
    }
    if (this.#error !== null) {
      this.#rejectOutcome(this.#error)
      if (this.#sessionRow === null) this.#rejectSession(this.#error)
    } else {
      this.#resolveOutcome(this.#outcomeRow!)
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

export function run(options: RunOptions): MercuryRun {
  return new MercuryRun(options)
}
