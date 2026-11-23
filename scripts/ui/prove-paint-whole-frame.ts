#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { AnsiEmulator, defaultSgr, type SgrState } from '../ink-runtime/ansiEmulator.ts'

delete process.env.NO_COLOR
process.env.FORCE_COLOR = '3'

const React = await import('react')
const h = React.createElement
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.tsx')
const { default: instances } = await import('../../src/screen/renderer/instances.ts')
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { AlternateScreen } = await import('../../src/screen/renderer/elements/AlternateScreen.tsx')
const { default: useInput } = await import('../../src/screen/renderer/bindings/use-input.ts')

const COLS = 64
const ROWS = 12
const ESC = '\u001b'
const ERASE_DISPLAY = /\u001b\[[0-3]?J/g
const ALT_SWITCH = /\u001b\[\?1049[hl]/
const UNMODELLED = /\u001b\[(?:[<>=][0-9;]*[a-zA-Z]|\?u|\??[0-9;]*\$p|c|[0-9;]*t)/g
const FOCUS_IN = `${ESC}[I`
const FOCUS_OUT = `${ESC}[O`
const WHOLE_FRAME_HEAD = `${ESC}[H${ESC}[0m`
const WHOLE_FRAME_GAP_MS = 250

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  const repairHint = 'fix the painter: src/screen/renderer/screenInstance.tsx (repaintAltScreen, armScreenWatchdog, onRender), src/screen/renderer/instance/alt-screen.ts, src/screen/renderer/instance/resize.ts (handleWinch, handleResize), and src/screen/renderer/frame-writer.ts for the clearTerminal reasons'
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} · ` : ''}${repairHint}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const plainOnBlank = (style: SgrState | null): boolean =>
  style === null || (style.bg === 'default' && !style.inverse && !style.underline && !style.strike)
const signature = (glyph: string, style: SgrState | null): string => {
  if (glyph === ' ' && plainOnBlank(style)) return ' '
  const s = style ?? defaultSgr()
  return `${glyph}\u0000${s.fg}|${s.bg}|${s.bold ? 'b' : ''}${s.dim ? 'd' : ''}${s.inverse ? 'r' : ''}${s.underline ? 'u' : ''}${s.strike ? 's' : ''}`
}

class Terminal extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  emulator = new AnsiEmulator(COLS, ROWS, true)
  log = ''
  write(bytes: string): boolean {
    this.log += bytes
    if (ALT_SWITCH.test(bytes)) this.fill(' ')
    this.emulator.feed(bytes.replace(UNMODELLED, ''))
    return true
  }
  mark(): number {
    return this.log.length
  }
  since(mark: number): string {
    return this.log.slice(mark)
  }
  fill(glyph: string): void {
    const stale = glyph === ' ' ? null : { bold: true, dim: false, italic: false, underline: true, inverse: true, strike: false, fg: '31', bg: '43' }
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        this.emulator.grid[y]![x] = glyph
        this.emulator.cellStyles[y]![x] = stale === null ? null : { ...stale }
      }
    }
    if (stale !== null) this.emulator.sgr = { ...stale }
  }
  cells(): string[] {
    const out: string[] = []
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) out.push(signature(this.emulator.grid[y]![x]!, this.emulator.styleAt(x, y)))
    }
    return out
  }
  text(): string {
    return this.emulator.lines().join('\n')
  }
}

class Keyboard extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  get readableLength(): number {
    return this.chunks.reduce((n, chunk) => n + chunk.length, 0)
  }
  setEncoding(): this {
    return this
  }
  setRawMode(value: boolean): this {
    this.isRaw = value
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
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}

function Scene({ tick, short = false }: { tick: number; short?: boolean }): React.ReactNode {
  useInput(() => {})
  const tail = short
    ? []
    : [
        h(Box, { flexGrow: 1 }),
        h(Box, { backgroundColor: 'rgb(13,24,27)', width: 30 }, h(Text, null, 'a row on its own ground')),
        h(Text, { dimColor: true }, 'foot row that never changes'),
      ]
  return h(
    AlternateScreen,
    { mouseTracking: false },
    h(
      Box,
      { flexDirection: 'column', width: COLS, ...(short ? {} : { height: ROWS }) },
      h(Text, null, 'head row that never changes'),
      h(Box, { height: 1 }),
      h(Text, { color: 'rgb(40,200,120)' }, `tick ${tick}`),
      ...tail,
    ),
  )
}

const settle = (ms = 220): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type World = { ink: InstanceType<typeof ScreenInstance>; screen: Terminal; keys: Keyboard; show: (tick: number) => void; end: () => Promise<void> }

async function world(): Promise<World> {
  const screen = new Terminal()
  const keys = new Keyboard()
  const ink = new ScreenInstance({ stdout: screen as never, stdin: keys as never, stderr: new Terminal() as never, patchConsole: false, exitOnCtrlC: false })
  instances.set(screen as never, ink)
  const show = (tick: number): void => ink.render(h(Scene, { tick }))
  show(1)
  await settle(450)
  return {
    ink,
    screen,
    keys,
    show,
    end: async () => {
      const exited = ink.waitUntilExit()
      ink.unmount()
      await exited
      instances.delete(screen as never)
    },
  }
}

const differing = (a: string[], b: string[]): number => a.reduce((n, cell, i) => n + (cell === b[i] ? 0 : 1), 0)
const erases = (bytes: string): number => (bytes.match(ERASE_DISPLAY) ?? []).length

section('1. the scene paints, and a diff frame writes only what changed')
{
  const w = await world()
  check('the first frame carries the head, the tick, the grounded row and the foot', ['head row that never changes', 'tick 1', 'a row on its own ground', 'foot row that never changes'].every(words => w.screen.text().includes(words)), w.screen.text())
  const mark = w.screen.mark()
  w.show(2)
  await settle()
  check('a tick repaints its own cell and no more', w.screen.text().includes('tick 2') && w.screen.since(mark).length < 120 && !w.screen.since(mark).includes('head row'), JSON.stringify(w.screen.since(mark)))
  await w.end()
}

section('2. the terminal changed behind the painter and the window got its focus back')
{
  const w = await world()
  const whole = w.screen.cells()
  w.screen.fill('#')
  const mark = w.screen.mark()
  w.keys.push(FOCUS_OUT)
  await settle(60)
  w.keys.push(FOCUS_IN)
  await settle()
  const left = differing(w.screen.cells(), whole)
  check('after focus-in every cell equals the frame the painter holds', left === 0, `${left} of ${COLS * ROWS} cells differ:\n${w.screen.text()}`)
  check('the repair overwrites in place: no erase of the display on the wire', erases(w.screen.since(mark)) === 0, JSON.stringify(w.screen.since(mark).slice(0, 200)))
  w.show(2)
  await settle()
  check('the next tick is a plain diff again', w.screen.text().includes('tick 2') && differing(w.screen.cells(), whole) <= 1, `${differing(w.screen.cells(), whole)} cells moved`)
  await w.end()
}

section('3. a SIGWINCH that changes no size')
{
  const w = await world()
  const whole = w.screen.cells()
  w.screen.fill('#')
  const mark = w.screen.mark()
  process.emit('SIGWINCH')
  await settle()
  const left = differing(w.screen.cells(), whole)
  check('after a same-size SIGWINCH every cell equals the frame the painter holds', left === 0, `${left} of ${COLS * ROWS} cells differ`)
  check('no erase of the display on the wire', erases(w.screen.since(mark)) === 0)
  await w.end()
}

section('4. the redraw key')
{
  const w = await world()
  const whole = w.screen.cells()
  w.screen.fill('#')
  const mark = w.screen.mark()
  w.ink.repaintAltScreen()
  await settle()
  const left = differing(w.screen.cells(), whole)
  check('after app:redraw no stale glyph survives where the frame is blank', left === 0, `${left} of ${COLS * ROWS} cells differ:\n${w.screen.text()}`)
  check('no erase of the display on the wire', erases(w.screen.since(mark)) === 0)
  await w.end()
}

section('5. the zero-byte watchdog after a hand-over')
{
  const w = await world()
  const whole = w.screen.cells()
  w.ink.armScreenWatchdog()
  const mark = w.screen.mark()
  for (let i = 0; i < 5; i++) w.ink.onRender()
  const fired = ALT_SWITCH.test(w.screen.since(mark))
  await settle()
  check('five frames that change nothing fire the watchdog (the alternate screen is re-entered)', fired, JSON.stringify(w.screen.since(mark).slice(0, 80)))
  const left = differing(w.screen.cells(), whole)
  check('the screen the re-entry cleared is whole again without waiting for a change', left === 0, `${left} of ${COLS * ROWS} cells differ:\n${w.screen.text()}`)
  w.show(2)
  await settle()
  const after = differing(w.screen.cells(), whole)
  check('the next change paints over a whole screen, not an erased one', w.screen.text().includes('tick 2') && w.screen.text().includes('head row that never changes') && w.screen.text().includes('foot row that never changes') && after <= 1, `${after} cells differ:\n${w.screen.text()}`)
  check('no erase of the display on the wire', erases(w.screen.since(mark)) === 0)
  await w.end()
}

section('6. a resize settles by overwriting')
{
  const w = await world()
  const mark = w.screen.mark()
  w.screen.columns = COLS - 4
  w.screen.rows = ROWS
  w.screen.emit('resize')
  await settle(500)
  const settled = w.screen.since(mark)
  check('the settled frame carries the scene', w.screen.text().includes('head row that never changes') && w.screen.text().includes('foot row that never changes'), w.screen.text())
  const expectedErases = process.env.TERM_PROGRAM === 'Apple_Terminal' ? 1 : 0
  check(`the shrink writes ${expectedErases} display erases`, erases(settled) === expectedErases, JSON.stringify(settled.slice(0, 160)))
  await w.end()
}

section('7. a burst of focus reports is bounded, and the last one still lands')
{
  const w = await world()
  const whole = w.screen.cells()
  const mark = w.screen.mark()
  const started = performance.now()
  for (let i = 0; i < 10; i++) {
    if (i === 9) w.screen.fill('#')
    w.keys.push(FOCUS_IN)
    await settle(20)
  }
  await settle(450)
  const elapsed = performance.now() - started
  const frames = w.screen.since(mark).split(WHOLE_FRAME_HEAD).length - 1
  const allowed = Math.floor(elapsed / WHOLE_FRAME_GAP_MS) + 1
  check('ten focus reports 20 ms apart paint at most one whole frame a quarter second, not ten', frames >= 1 && frames <= allowed && frames < 10, `${frames} whole frames in ${Math.round(elapsed)} ms`)
  const left = differing(w.screen.cells(), whole)
  check('the screen lost before the last report is whole after it', left === 0, `${left} of ${COLS * ROWS} cells differ`)
  await w.end()
}

section('9. the clearTerminal patch: the two frames that still return it, and a shorter alternate screen is not one of them')
{
  const w = await world()
  const mark = w.screen.mark()
  w.ink.render(h(Scene, { tick: 1, short: true }))
  await settle()
  const bytes = w.screen.since(mark)
  check('a shorter tree on the alternate screen is diffed in place: its old rows leave and nothing erases the display', erases(bytes) === 0 && !w.screen.text().includes('foot row that never changes') && !w.screen.text().includes('a row on its own ground') && w.screen.text().includes('head row that never changes'), `${JSON.stringify(bytes.slice(0, 120))}\n${w.screen.text()}`)
  await w.end()
  const { FrameWriter } = await import('../../src/screen/renderer/frame-writer.ts')
  const { createScreen, StylePool, CharPool, HyperlinkPool } = await import('../../src/screen/renderer/cell-grid.ts')
  const styles = new StylePool()
  const glyphs = new CharPool()
  const links = new HyperlinkPool()
  const writer = new FrameWriter({ isTTY: true, stylePool: styles })
  const frame = (screenRows: number, viewportRows: number): unknown => ({ screen: createScreen(COLS, screenRows, styles, glyphs, links), viewport: { width: COLS, height: viewportRows }, cursor: { x: 0, y: 0, visible: false } })
  const clears = (base: unknown, next: unknown): string[] => writer.render(base as never, next as never, true).flatMap(patch => (patch.type === 'clearTerminal' ? [patch.reason] : []))
  check('a frame the size of its base returns no clearTerminal patch', clears(frame(ROWS, ROWS), frame(ROWS, ROWS)).length === 0)
  check("a frame whose viewport differs from its base's returns it as 'resize'", JSON.stringify(clears(frame(ROWS, ROWS), frame(ROWS + 1, ROWS + 1))) === '["resize"]', JSON.stringify(clears(frame(ROWS, ROWS), frame(ROWS + 1, ROWS + 1))))
  check("a frame whose screen is shorter than its base's returns it as 'offscreen': only a root with no layout composes one, the alternate screen's own frame is always the terminal's rows", JSON.stringify(clears(frame(ROWS, ROWS), frame(0, ROWS))) === '["offscreen"]', JSON.stringify(clears(frame(ROWS, ROWS), frame(0, ROWS))))
}

console.log(`\npaint-whole-frame: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
