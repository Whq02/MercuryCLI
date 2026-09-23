import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const KEY = {
  esc: '\x1b',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
}

export function pinScratchHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-`))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.FORCE_COLOR = '3'
  process.env.MERCURY_CRITTER_IDLE = '0'
  process.env.MERCURY_CRITTER_GAZE = '0'
  process.env.MERCURY_CRITTER_SLEEP = '0'
  process.env.MERCURY_LIVE_CLOCK = '0'
  process.env.MERCURY_LIVE_GLYPHS = '0'
  process.env.MERCURY_RECESS = '0'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  return home
}

class FakeStdout extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  writes: string[] = []
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  setEncoding(): this {
    return this
  }
  setRawMode(v: boolean): this {
    this.isRaw = v
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  read(): string | null {
    return this.chunks.shift() ?? null
  }
  get readableLength(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}

const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g

export type Mounted = {
  push: (data: string) => void
  lines: () => string[]
  screen: () => string
  styleAt: (x: number, y: number) => { bg: string; fg: string; bold: boolean; inverse: boolean } | null
  unmount: () => void
}

export async function mountOffscreen(element: unknown, columns: number, rows: number): Promise<Mounted> {
  const { default: Ink } = await import('../../src/ink/ink.js')
  const { default: instances } = await import('../../src/ink/instances.js')
  const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')
  const stdout = new FakeStdout(columns, rows)
  const stdin = new FakeStdin()
  const ink = new Ink({
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout(columns, rows) as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(stdout as never, ink)
  ink.setAltScreenActive(true, false)
  ink.render(element as never)
  const replay = (): InstanceType<typeof AnsiEmulator> => {
    const emu = new AnsiEmulator(columns, rows, true)
    for (const w of stdout.writes) emu.feed(w.replace(PROBE_CSI, ''))
    return emu
  }
  return {
    push: data => stdin.push(data),
    lines: () => replay().lines().map(line => line.replace(/\s+$/, '')),
    screen: () => replay().lines().join('\n'),
    styleAt: (x, y) => {
      const style = replay().styleAt(x, y)
      return style === null ? null : { bg: style.bg, fg: style.fg, bold: style.bold, inverse: style.inverse }
    },
    unmount: () => {
      ink.unmount()
      instances.delete(stdout as never)
    },
  }
}

export const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await settle(40)
  }
  return pred()
}
