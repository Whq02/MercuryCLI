import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRAME_INTERVAL_MS } from '../../src/screen/renderer/constants.js'
import instances from '../../src/screen/renderer/instances.js'

export function pinSourceRef(argv: string[] = process.argv): string | undefined {
  const at = argv.indexOf('--source-ref')
  const ref = at < 0 ? undefined : argv[at + 1]
  if (ref === undefined) return undefined
  const root = join(import.meta.dir, '../..')
  const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', '--diff-filter=M', ref, '--', 'src'], { encoding: 'utf8' }).trim().split('\n').filter(file => /\.tsx?$/.test(file))
  const sources = new Map(changed.map(file => [file, execFileSync('git', ['-C', root, 'show', `${ref}:${file}`], { encoding: 'utf8' })]))
  Bun.plugin({
    name: 'versioned-product-source',
    setup(build) {
      for (const [file, contents] of sources) {
        const path = join(root, file)
        build.onLoad({ filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({ contents, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' }))
      }
    },
  })
  console.log(`Rendering product source from ${ref}; ${sources.size} changed modules restored in the loader`)
  return ref
}

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
  process.env.MERCURY_CLIPBOARD_FILE = join(home, 'clipboard.txt')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  return home
}

export async function releaseScratchHome(home: string): Promise<void> {
  process.chdir(tmpdir())
  let fault = ''
  for (const attempt of [1, 2]) {
    try {
      rmSync(home, { recursive: true, force: true })
      return
    } catch (error) {
      fault = String(error)
      if (attempt === 1) await pause(250)
    }
  }
  const swept = process.platform === 'win32' ? null : spawnSync('rm', ['-rf', home], { encoding: 'utf8' })
  const complaint = (swept?.stderr ?? '').trim()
  const outcome = existsSync(home) ? `left in place${complaint === '' ? '' : ` (rm: ${complaint})`}` : 'removed by rm -rf'
  console.log(`scratch home ${home}: rmSync failed twice — ${fault} — ${outcome}; the verdict stands`)
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
  unfinished = false
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
    this.unfinished = data.endsWith('\x1b')
    this.chunks.push(data)
    this.emit('readable')
  }
}

const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
const WIDTH_PROBE_WRITE = /\x1b7.*\x1b\[6n/s

export type Mounted = {
  push: (data: string) => void
  lines: () => string[]
  screen: () => string
  cursor: () => { x: number; y: number; visible: boolean }
  styleAt: (x: number, y: number) => { bg: string; fg: string; bold: boolean; inverse: boolean } | null
  resize: (element: unknown, columns: number, rows: number) => void
  unmount: () => void
}

export async function mountOffscreen(element: unknown, columns: number, rows: number, opts?: { mouseTracking?: boolean }): Promise<Mounted> {
  const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
  const { default: instances } = await import('../../src/screen/renderer/instances.js')
  const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
  const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')
  const stdout = new FakeStdout(columns, rows)
  const stdin = new FakeStdin()
  const ink = new ScreenInstance({
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout(columns, rows) as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(stdout as never, ink)
  ink.setAltScreenActive(true, opts?.mouseTracking ?? false)
  ink.render(element as never)
  const replay = (): InstanceType<typeof AnsiEmulator> => {
    const emu = new AnsiEmulator(columns, rows, true)
    for (const w of stdout.writes) {
      if (WIDTH_PROBE_WRITE.test(w)) continue
      emu.feed(w.replace(PROBE_CSI, ''))
    }
    return emu
  }
  return {
    push: data => stdin.push(data),
    lines: () => replay().lines().map(line => line.replace(/\s+$/, '')),
    screen: () => replay().lines().join('\n'),
    cursor: () => {
      const frame = replay()
      return { x: frame.cursorX, y: frame.cursorY, visible: frame.cursorVisible }
    },
    styleAt: (x, y) => {
      const style = replay().styleAt(x, y)
      return style === null ? null : { bg: style.bg, fg: style.fg, bold: style.bold, inverse: style.inverse }
    },
    resize: (next, nextColumns, nextRows) => {
      if (columns === nextColumns && rows === nextRows) { ink.render(next as never); return }
      columns = nextColumns
      rows = nextRows
      stdout.columns = columns
      stdout.rows = rows
      stdout.writes.length = 0
      ink.invalidatePrevFrame()
      stdout.emit('resize')
      ink.render(next as never)
    },
    unmount: () => {
      ink.unmount()
      instances.delete(stdout as never)
      disposeKeybindingWatcher()
    },
  }
}

export const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export const settle = (ms: number): Promise<void> => pause(ms)

const screensAtRest = (): boolean => [...instances.values()].every(ink => !ink.isRendering && ink.resizeSettleTimer === null && ink.overwriteTimer === null && ink.scheduler.state() === 'idle')

const takeUnfinishedInput = (): boolean => {
  let held = false
  for (const ink of instances.values()) {
    const stdin: unknown = ink.options.stdin
    if (stdin instanceof FakeStdin && stdin.unfinished) {
      stdin.unfinished = false
      held = true
    }
  }
  return held
}

export async function painted(ms: number): Promise<void> {
  if (instances.size === 0 || takeUnfinishedInput()) return pause(ms)
  const from = performance.now()
  const floor = Math.min(ms, FRAME_INTERVAL_MS)
  for (let rested = 0; performance.now() - from < ms; ) {
    await pause(1)
    rested = performance.now() - from >= floor && screensAtRest() ? rested + 1 : 0
    if (rested >= 2) return
  }
}

export async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await pause(40)
  }
  return pred()
}
