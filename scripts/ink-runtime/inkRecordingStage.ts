import { EventEmitter } from 'node:events'
import { closeSync, openSync, readSync } from 'node:fs'

export type WorldName = 'plain' | 'atomic' | 'test'

const CLEARED = [
  'WT_SESSION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'KITTY_WINDOW_ID', 'ZED_TERM', 'VTE_VERSION', 'TMUX', 'STY', 'LC_TERMINAL',
  'ConEmuANSI', 'ConEmuPID', 'ConEmuTask', 'MSYSTEM', 'SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'DEBUG',
  'INK_TREE_DUMP', 'INK_COMPOSED_TEE', 'INK_COMMIT_TEE', 'INK_WRITE_TEE', 'INK_WRITE_TEE_FULL', 'INK_TEE_PROBE',
  'MERCURY_FORCE_SYNC_OUTPUT', 'MERCURY_NO_SYNC_OUTPUT', 'MERCURY_FRAME_COST_PAD_MS', 'MERCURY_POINTER_SHAPE', 'MERCURY_TERMINAL_QUERY_SETTLE_MS',
  'MERCURY_FLUX_PROBE', 'MERCURY_FLUX_PROBE_TEE', 'MERCURY_FULLSCREEN', 'MERCURY_CLIPBOARD_FILE', 'MERCURY_ACCESSIBILITY', 'MERCURY_ALT_HELD',
  'MERCURY_CLICK_DEBUG', 'MERCURY_ERROR_REPORTING', 'TERMINAL_EMULATOR', 'KONSOLE_VERSION', 'FORCE_HYPERLINK', 'NETLIFY',
]

export const WORLDS: Record<WorldName, { says: string; env: Record<string, string> }> = {
  plain: {
    says: 'a terminal that names itself to nothing: no atomic drawing, no extended keys, no pointer shapes',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3', NODE_ENV: 'production', MERCURY_POINTER_SHAPE: '0' },
  },
  atomic: {
    says: 'a terminal that draws atomically and speaks the extended keys, with pointer shapes on',
    env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2.0', COLORTERM: 'truecolor', FORCE_COLOR: '3', NODE_ENV: 'production', MERCURY_POINTER_SHAPE: '1' },
  },
  test: {
    says: 'the plain terminal under the test environment, where a commit paints at once',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', NODE_ENV: 'test', MERCURY_POINTER_SHAPE: '0' },
  },
}

export const TEE_NAMES = ['INK_TREE_DUMP', 'INK_COMPOSED_TEE', 'INK_COMMIT_TEE', 'INK_WRITE_TEE'] as const

export function enterWorld(world: WorldName): void {
  for (const name of CLEARED) delete process.env[name]
  Object.assign(process.env, WORLDS[world].env)
}

const EPOCH_MS = 1_700_000_000_000
const READ_TICK_MS = 1e-6

type Due = { id: number; at: number; every: number | null; run: () => void }

const real = {
  setImmediate: globalThis.setImmediate,
  queueMicrotask: globalThis.queueMicrotask,
  stderrWrite: process.stderr.write.bind(process.stderr),
}

let clock = 0
let reads = 0
let ids = 0
const timers = new Map<number, Due>()
let immediates: Array<{ id: number; run: () => void }> = []
const lines: string[] = []
let fd1: number | null = null
let fd1At = 0
let draining = false
const FD1_BUFFER = Buffer.alloc(64 * 1024)

class Handle {
  constructor(readonly id: number, private readonly refresher: (() => void) | null = null) {}
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  hasRef(): boolean {
    return true
  }
  refresh(): this {
    this.refresher?.()
    return this
  }
  [Symbol.toPrimitive](): number {
    return this.id
  }
}

const idOf = (handle: unknown): number | null => (handle instanceof Handle ? handle.id : typeof handle === 'number' ? handle : null)

export function escaped(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (code === 0x1b) out += '\\e'
    else if (code === 0x07) out += '\\a'
    else if (code === 0x0a) out += '\\n'
    else if (code === 0x0d) out += '\\r'
    else if (code === 0x09) out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else if (code > 0x7e) out += `\\u{${code.toString(16)}}`
    else out += ch
  }
  return out
}

function drainFd1(): void {
  if (fd1 === null || draining) return
  draining = true
  try {
    for (;;) {
      const read = readSync(fd1, FD1_BUFFER, 0, FD1_BUFFER.length, fd1At)
      if (read <= 0) break
      fd1At += read
      const bytes = FD1_BUFFER.subarray(0, read).toString('utf8')
      terminal.take(bytes)
      lines.push(`fd1 ${escaped(bytes)}`)
    }
  } finally {
    draining = false
  }
}

const hidden: Array<[found: string, said: string]> = []

export function hide(found: string, said: string): void {
  if (found !== '') hidden.push([escaped(found), said])
}

export function note(line: string): void {
  drainFd1()
  lines.push(hidden.reduce((text, [found, said]) => text.replaceAll(found, said), line))
}

export function recorded(): string[] {
  drainFd1()
  return lines
}

class TerminalModes {
  private readonly dec = new Set<number>()
  private cursorShown = true
  private kitty = 0
  private modifyOtherKeys = 0
  private region = 'whole'
  private pointer = 'unset'

  take(bytes: string): void {
    for (const m of bytes.matchAll(/\u001b\[([?>=<]?)([0-9;]*)([ -/]?)([@-~])|\u001b\]22;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g)) {
      if (m[5] !== undefined) {
        this.pointer = m[5] === '' ? 'reset' : m[5]
        continue
      }
      const [, lead, params, , final] = m
      if (lead === '?' && (final === 'h' || final === 'l')) {
        for (const param of params!.split(';')) {
          const mode = Number(param)
          if (mode === 25) this.cursorShown = final === 'h'
          else if (final === 'h') this.dec.add(mode)
          else this.dec.delete(mode)
        }
      } else if (lead === '>' && final === 'u') this.kitty += 1
      else if (lead === '<' && final === 'u') this.kitty = Math.max(0, this.kitty - 1)
      else if (lead === '>' && final === 'm' && params!.startsWith('4')) this.modifyOtherKeys = Number(params!.split(';')[1] ?? 0)
      else if (lead === '' && final === 'r') this.region = params === '' ? 'whole' : params!.replace(';', '..')
    }
  }

  words(): string {
    const dec = [...this.dec].sort((a, b) => a - b).join(' ')
    return `dec[${dec}] cursor=${this.cursorShown ? 'shown' : 'hidden'} kitty=${this.kitty} otherkeys=${this.modifyOtherKeys} region=${this.region} pointer=${this.pointer}`
  }
}

export const terminal = new TerminalModes()

export const wordsOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!

const DEBUG_LINE = /^\d{4}-\d\d-\d\dT[0-9:.]+Z \[([A-Z]+)\] ([^\n]*)/
const UNIT_FRAME = /[\\/]src[\\/]screen[\\/]renderer[\\/](?:screenInstance\.tsx|instance[\\/])/

export function installStage(fd1File: string | null): void {
  if (fd1File !== null) fd1 = openSync(fd1File, 'r')
  const scope = globalThis as Record<string, unknown>
  scope.setTimeout = (run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = ++ids
    const wait = Math.max(0, Number(ms) || 0)
    const due: Due = { id, at: clock + wait, every: null, run: () => run(...args) }
    timers.set(id, due)
    return new Handle(id, () => {
      if (timers.has(id)) due.at = clock + wait
    })
  }
  scope.setInterval = (run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = ++ids
    const every = Math.max(1, Number(ms) || 0)
    timers.set(id, { id, at: clock + every, every, run: () => run(...args) })
    return new Handle(id)
  }
  scope.clearTimeout = (handle: unknown) => {
    const id = idOf(handle)
    if (id !== null) timers.delete(id)
  }
  scope.clearInterval = scope.clearTimeout
  scope.setImmediate = (run: (...args: unknown[]) => void, ...args: unknown[]) => {
    const id = ++ids
    immediates.push({ id, run: () => run(...args) })
    return new Handle(id)
  }
  scope.clearImmediate = (handle: unknown) => {
    const id = idOf(handle)
    if (id !== null) immediates = immediates.filter(entry => entry.id !== id)
  }
  scope.queueMicrotask = (run: () => void) => {
    real.queueMicrotask(() => {
      try {
        run()
      } catch (error) {
        note(`thrown out of a microtask: ${wordsOf(error)}`)
      }
    })
  }
  Date.now = () => EPOCH_MS + Math.floor(clock)
  performance.now = () => {
    drainFd1()
    reads += 1
    return clock + reads * READ_TICK_MS
  }
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    const line = DEBUG_LINE.exec(text)
    if (line === null) return (real.stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
    const callers = (new Error().stack ?? '').split('\n')
    const logged = callers.findIndex(frame => /\blogForDebugging\b/.test(frame))
    if (logged < 0 || !UNIT_FRAME.test(callers[logged + 1] ?? '')) return true
    const said = `[${line[1]}] ${line[2]!}`
    note(`debug ${escaped(said)}`)
    debugSink?.(said)
    return true
  }) as typeof process.stderr.write
}

let debugSink: ((line: string) => void) | null = null

export function sendDebugLinesTo(sink: ((line: string) => void) | null): void {
  debugSink = sink
}

export function leaveStage(): void {
  if (fd1 !== null) closeSync(fd1)
  fd1 = null
}

export function ticks(ms: number): number {
  return Math.round(ms / READ_TICK_MS)
}

const microtasks = (): Promise<void> => new Promise(done => real.setImmediate(done))

function guarded(what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    note(`thrown out of ${what}: ${wordsOf(error)}`)
  }
}

export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20_000; turn++) {
    await microtasks()
    const next = immediates.shift()
    if (next === undefined) return
    guarded('an immediate', next.run)
  }
  throw new Error('the stage never settled: an immediate asks for another without end')
}

export async function advance(ms: number): Promise<void> {
  const target = clock + ms
  await settle()
  for (;;) {
    let next: Due | null = null
    for (const due of timers.values()) {
      if (due.at <= target && (next === null || due.at < next.at || (due.at === next.at && due.id < next.id))) next = due
    }
    if (next === null) break
    clock = Math.max(clock, next.at)
    if (next.every === null) timers.delete(next.id)
    else next.at += next.every
    guarded('a timer', next.run)
    await settle()
  }
  clock = target
}

export function pendingTimers(): string {
  return [...timers.values()]
    .map(due => Math.round((due.at - clock) * 1000) / 1000)
    .sort((a, b) => a - b)
    .join(' ')
}

export class StageScreen extends EventEmitter {
  isTTY: boolean
  columns: number
  rows: number
  windowSize: [number, number]
  destroyed = false
  writable = true
  writableEnded = false
  failures: Error[] = []
  onWrite: ((bytes: string) => void) | null = null
  readonly writes: string[] = []

  constructor(private readonly label: 'out' | 'err', columns: number, rows: number, isTTY = true) {
    super()
    this.isTTY = isTTY
    this.columns = columns
    this.rows = rows
    this.windowSize = [columns, rows]
  }

  write(bytes: string | Uint8Array, encodingOrDone?: unknown, done?: unknown): boolean {
    const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')
    const failure = this.failures.shift()
    if (failure !== undefined) {
      note(`${this.label} refuses a write of ${text.length} chars: ${failure.message}`)
      throw failure
    }
    if (this.label === 'out') terminal.take(text)
    this.writes.push(text)
    note(`${this.label} ${escaped(text)}`)
    const hook = this.onWrite
    if (hook !== null) hook(text)
    const callback = typeof encodingOrDone === 'function' ? encodingOrDone : done
    if (typeof callback === 'function') real.queueMicrotask(() => (callback as (error?: Error | null) => void)(null))
    return true
  }

  getWindowSize(): [number, number] {
    return this.windowSize
  }

  _refreshSize(): void {
    note(`${this.label} is asked for its size`)
    const [columns, rows] = this.windowSize
    if (columns === this.columns && rows === this.rows) return
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }

  becomes(columns: number, rows: number): void {
    this.windowSize = [columns, rows]
    this.columns = columns
    this.rows = rows
  }

  resizes(columns: number, rows: number): void {
    this.becomes(columns, rows)
    this.emit('resize')
  }
}

export class StageKeys extends EventEmitter {
  isTTY: boolean
  isRaw = false
  destroyed = false
  rawRefusals = 0
  private readonly queue: string[] = []
  _handle: { reading: boolean; readStop: () => void } | null = null
  _readableState: { reading: boolean } | null = null

  constructor(isTTY = true) {
    super()
    this.isTTY = isTTY
  }

  get readableLength(): number {
    return this.queue.reduce((n, chunk) => n + chunk.length, 0)
  }

  setEncoding(): this {
    return this
  }

  setRawMode(raw: boolean): this {
    if (raw && this.rawRefusals > 0) {
      this.rawRefusals -= 1
      note('stdin is asked for raw mode and does not take it')
      return this
    }
    this.isRaw = raw
    note(`stdin raw ${raw ? 'on' : 'off'}`)
    return this
  }

  ref(): this {
    note('stdin ref')
    return this
  }

  unref(): this {
    note('stdin unref')
    return this
  }

  pause(): this {
    return this
  }

  resume(): this {
    return this
  }

  read(size?: number): string | null {
    if (size === 0) {
      note('stdin read(0)')
      return null
    }
    return this.queue.shift() ?? null
  }

  override addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'readable') note('stdin gains a readable listener')
    return super.addListener(event, listener)
  }

  override removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'readable' && this.listeners('readable').includes(listener)) note('stdin loses a readable listener')
    return super.removeListener(event, listener)
  }

  holdsConsoleRead(): void {
    this._handle = {
      reading: true,
      readStop: () => note('stdin stops its console read'),
    }
    this._readableState = { reading: true }
  }

  sends(bytes: string): void {
    this.queue.push(bytes)
    this.emit('readable')
  }

  words(): string {
    return `raw=${this.isRaw ? 'on' : 'off'} readable=${this.listenerCount('readable')}`
  }
}
