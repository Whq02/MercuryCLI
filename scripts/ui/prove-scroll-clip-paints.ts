#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.ts'

delete process.env.NO_COLOR
process.env.FORCE_COLOR = '3'

const React = await import('react')
const h = React.createElement
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { default: instances } = await import('../../src/ink/instances.ts')
const { Box, Text } = await import('../../src/ink.ts')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.tsx')
const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.tsx')
const { pendingClears } = await import('../../src/ink/node-cache.ts')
type Handle = import('../../src/ink/components/ScrollBox.tsx').ScrollBoxHandle
type Node = import('../../src/ink/dom.ts').DOMElement

const SRC = join(import.meta.dir, '..', '..', 'src')
const COLS = 40
const ROWS = 14
const ITEMS = 20
const ITEM_ROWS = 3
const TICK_ITEM = 10
const LAST_ROW = ITEMS * ITEM_ROWS - 1
const ALT_SWITCH = /\u001b\[\?1049[hl]/
const UNMODELLED = /\u001b\[(?:[<>=][0-9;]*[a-zA-Z]|\?u|\??[0-9;]*\$p|c|[0-9;]*t)/g
const PADDED_BOXES: Record<string, string[]> = { 'components/FullscreenLayout.tsx': ['paddingTop'] }

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

class Terminal extends EventEmitter {
  isTTY = true
  columns = COLS
  rows: number
  emulator: AnsiEmulator
  constructor(rows: number) {
    super()
    this.rows = rows
    this.emulator = new AnsiEmulator(COLS, rows, true)
  }
  write(bytes: string): boolean {
    if (ALT_SWITCH.test(bytes)) this.emulator = new AnsiEmulator(COLS, this.rows, true)
    this.emulator.feed(bytes.replace(UNMODELLED, ''))
    return true
  }
  resizeTo(rows: number, columns = this.columns): void {
    this.rows = rows
    this.columns = columns
    this.emulator = new AnsiEmulator(columns, rows, true)
    this.emit('resize')
  }
  text(): string {
    return this.emulator.lines().join('\n')
  }
}

class Keyboard extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
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
    return null
  }
}

type Variant = { name: string; paddingTop: number; paddingBottom: number; ground?: string }
const TRANSCRIPT: Variant = { name: 'one row of padding above, as the transcript pane has', paddingTop: 1, paddingBottom: 0 }
const GROUNDED: Variant = { name: 'padding above and below on the box\'s own ground', paddingTop: 1, paddingBottom: 1, ground: 'rgb(13,24,27)' }
const BARE: Variant = { name: 'no padding', paddingTop: 0, paddingBottom: 0 }

const rowWords = (row: number, tick: number): string => {
  const item = Math.floor(row / ITEM_ROWS)
  return item === TICK_ITEM && row % ITEM_ROWS === 1 ? `row ${String(row).padStart(2, '0')} tick ${tick}` : `row ${String(row).padStart(2, '0')} of item ${item}`
}

const NONE: ReadonlySet<number> = new Set()

function Scene({ variant, tick, rows, cols, handle, gone, tail }: { variant: Variant; tick: number; rows: number; cols: number; handle: { current: Handle | null }; gone: ReadonlySet<number>; tail: { current: Node | null } }): React.ReactNode {
  const items = Array.from({ length: ITEMS }, (_, item) => item).filter(item => !gone.has(item)).map(item =>
    h(Box, { key: item, flexDirection: 'column', flexShrink: 0, ...(item === ITEMS - 1 ? { ref: tail } : {}) }, ...Array.from({ length: ITEM_ROWS }, (_, k) => h(Text, { key: k }, rowWords(item * ITEM_ROWS + k, tick)))),
  )
  const pane = h(ScrollBox, { ref: handle, flexDirection: 'column', height: rows - 2, flexShrink: 0, paddingTop: variant.paddingTop, paddingBottom: variant.paddingBottom, ...(variant.ground ? { backgroundColor: variant.ground as never } : {}) }, ...items)
  return h(AlternateScreen, { mouseTracking: false }, h(Box, { flexDirection: 'column', width: cols, height: rows }, h(Text, null, 'head'), pane, h(Text, null, 'foot')))
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type Shot = { top: number; tick: number; rows: number; text: string }
type World = {
  handle: Handle
  screen: Terminal
  shots: Shot[]
  last: () => Shot
  arrive: (top: number) => Promise<boolean>
  setTick: (tick: number) => void
  setGone: (gone: ReadonlySet<number>) => Promise<void>
  content: () => Node | null
  resize: (rows: number, cols?: number) => Promise<void>
  end: () => Promise<void>
}

async function world(variant: Variant, at?: number, tick = 0, gone: ReadonlySet<number> = NONE, cols = COLS): Promise<World> {
  const handle: { current: Handle | null } = { current: null }
  const tail: { current: Node | null } = { current: null }
  const screen = new Terminal(ROWS)
  screen.columns = cols
  const shots: Shot[] = []
  const shown = { tick, rows: ROWS, cols, gone }
  const ink = new Ink({
    stdout: screen as never,
    stdin: new Keyboard() as never,
    stderr: new Terminal(ROWS) as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: () => {
      shots.push({ top: handle.current?.getScrollTop() ?? -1, tick: shown.tick, rows: shown.rows, text: ink.lastFrameText() })
    },
  })
  instances.set(screen as never, ink)
  const show = (): void => ink.render(h(Scene, { variant, tick: shown.tick, rows: shown.rows, cols: shown.cols, handle, gone: shown.gone, tail }))
  show()
  if (at !== undefined) handle.current!.scrollTo(at)
  await settle(260)
  const arrive = async (top: number): Promise<boolean> => {
    const deadline = performance.now() + 1500
    while (performance.now() < deadline) {
      if (handle.current!.getScrollTop() === top && handle.current!.getPendingDelta() === 0 && shots.at(-1)?.top === top) break
      await settle(8)
    }
    await settle(40)
    return handle.current!.getScrollTop() === top && shots.at(-1)?.top === top
  }
  return {
    handle: handle.current!,
    screen,
    shots,
    last: () => shots.at(-1)!,
    arrive,
    setTick: next => {
      shown.tick = next
      show()
    },
    setGone: async next => {
      shown.gone = next
      show()
      await settle(160)
    },
    content: () => tail.current?.parentNode ?? null,
    resize: async (rows, columns = shown.cols) => {
      shown.rows = rows
      shown.cols = columns
      screen.resizeTo(rows, columns)
      await settle(320)
      show()
      await settle(120)
    },
    end: async () => {
      const exited = ink.waitUntilExit()
      ink.unmount()
      await exited
      instances.delete(screen as never)
    },
  }
}

const freshFrames = new Map<string, string>()
async function freshMount(variant: Variant, top: number, tick: number, gone: ReadonlySet<number> = NONE, cols = COLS): Promise<string> {
  const key = `${variant.name}\u0000${top}\u0000${tick}\u0000${[...gone].join(',')}\u0000${cols}`
  const known = freshFrames.get(key)
  if (known !== undefined) return known
  const w = await world(variant, top, tick, gone, cols)
  const text = w.last().text
  await w.end()
  freshFrames.set(key, text)
  return text
}

const paneOf = (text: string): string => text.split('\n').slice(1, -1).map(row => row.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(4, 6) || '··').join(' ')

async function wrongFrames(variant: Variant, shots: Shot[]): Promise<{ compared: number; wrong: string[] }> {
  const wrong: string[] = []
  let compared = 0
  for (const shot of shots) {
    if (shot.top < 0 || shot.rows !== ROWS) continue
    compared++
    const fresh = await freshMount(variant, shot.top, shot.tick)
    if (shot.text !== fresh) wrong.push(`at ${shot.top}: painted ${paneOf(shot.text)} · a fresh mount ${paneOf(fresh)}`)
  }
  return { compared, wrong }
}

async function roads(variant: Variant): Promise<void> {
  const w = await world(variant)
  const viewport = w.handle.getViewportHeight()
  const max = LAST_ROW + 1 - viewport
  const far = (top: number): number => (top > max / 2 ? 0 : max)
  const arrived: string[] = []
  const missed: string[] = []
  const go = async (label: string, top: number, from: number, by: number | null): Promise<void> => {
    if (from < 0 || from > max || top < 0 || top > max) return
    w.handle.scrollTo(far(from))
    await w.arrive(far(from))
    if (from !== far(from)) {
      w.handle.scrollTo(from)
      await w.arrive(from)
    }
    if (by === null) w.handle.scrollTo(top)
    else w.handle.scrollBy(by)
    ;((await w.arrive(top)) ? arrived : missed).push(`${label} to ${top}`)
  }
  for (const top of [TICK_ITEM * ITEM_ROWS + 1, TICK_ITEM * ITEM_ROWS, 2, 0, max - 1, max]) {
    await go('a jump', top, far(top), null)
    await go('three rows up the page', top, top - 3, 3)
    await go('three rows down the page', top, top + 3, -3)
    await go('one row up the page', top, top - 1, 1)
    await go('one row down the page', top, top + 1, -1)
    await go('a page less one row', top, top - (viewport - 1), viewport - 1)
    await go('a whole page', top, top - viewport, viewport)
    await go('a whole page back', top, top + viewport, -viewport)
  }
  const { compared, wrong } = await wrongFrames(variant, w.shots)
  check(`${variant.name}: every road arrived where it was sent (${arrived.length} arrivals)`, missed.length === 0 && arrived.length >= 30, missed.join(' · '))
  check(`${variant.name}: every frame painted on the way and at the end is the frame of a fresh mount at that position (${compared} frames)`, wrong.length === 0, `${wrong.length} of ${compared} differ; first: ${wrong[0]}`)
  const top = TICK_ITEM * ITEM_ROWS + 1
  w.handle.scrollTo(far(top))
  await w.arrive(far(top))
  w.handle.scrollTo(top)
  await w.arrive(top)
  const onScreen = w.screen.text()
  const composed = w.last().text.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(row => row.replace(/\s+$/, '')).join('\n')
  check(`${variant.name}: the terminal holds what was composed after all of it`, onScreen === composed, `terminal\n${onScreen}\ncomposed\n${composed}`)
  await w.end()
}

section('1. wheel, page and jump: one position paints one way')
for (const variant of [TRANSCRIPT, GROUNDED, BARE]) await roads(variant)

section('2. what the pane\'s first row holds')
{
  const boundary = TICK_ITEM * ITEM_ROWS
  const paneRows = (text: string): string[] => text.split('\n').slice(1, -1).map(row => row.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+$/, ''))
  const atBoundary = paneRows(await freshMount(TRANSCRIPT, boundary, 0))
  const inside = paneRows(await freshMount(TRANSCRIPT, boundary + 1, 0))
  const atTop = paneRows(await freshMount(TRANSCRIPT, 0, 0))
  check('scrolled to where an item ends at the viewport\'s edge, the first row is the last row of that item', atBoundary[0] === rowWords(boundary - 1, 0) && atBoundary[1] === rowWords(boundary, 0), JSON.stringify(atBoundary.slice(0, 2)))
  check('scrolled into an item, the first row is the row of that item above the viewport', inside[0] === rowWords(boundary, 0) && inside[1] === rowWords(boundary + 1, 0), JSON.stringify(inside.slice(0, 2)))
  check('at the very top nothing is above, and the first row is the blank padding', atTop[0] === '' && atTop[1] === rowWords(0, 0), JSON.stringify(atTop.slice(0, 2)))
  const bare = paneRows(await freshMount(BARE, boundary, 0))
  check('a box with no padding starts on its first viewport row, as before', bare[0] === rowWords(boundary, 0), JSON.stringify(bare.slice(0, 2)))
}

section('3. a row that changes while the wheel moves it into the first row')
for (const variant of [TRANSCRIPT, GROUNDED]) {
  const top = TICK_ITEM * ITEM_ROWS + 2
  const w = await world(variant, top - 3)
  await w.arrive(top - 3)
  w.setTick(1)
  w.handle.scrollBy(3)
  const there = await w.arrive(top)
  const { compared, wrong } = await wrongFrames(variant, w.shots.filter(shot => shot.tick === 1))
  check(`${variant.name}: the changed row arrives in the first row as a fresh mount shows it`, there && compared > 0 && wrong.length === 0 && w.last().text.includes(rowWords(top - 1, 1)), `${wrong.length} of ${compared} differ; first: ${wrong[0]}`)
  await w.end()
}

section('4. a resize and the way back')
for (const variant of [TRANSCRIPT, BARE]) {
  const top = TICK_ITEM * ITEM_ROWS + 1
  const w = await world(variant, top)
  await w.arrive(top)
  await w.resize(ROWS - 3)
  await w.resize(ROWS)
  const back = await w.arrive(top)
  const fresh = await freshMount(variant, top, 0)
  check(`${variant.name}: back at the first size the frame is the fresh mount's`, back && w.last().text === fresh, `painted ${paneOf(w.last().text)} · a fresh mount ${paneOf(fresh)}`)
  await w.end()
}

section('5. an item removed while the pane rests at the tail, every item painted once before')
for (const variant of [TRANSCRIPT, GROUNDED, BARE]) {
  for (const [where, item] of [['above the viewport', 2], ['inside the viewport', ITEMS - 3]] as const) {
    const w = await world(variant)
    const viewport = w.handle.getViewportHeight()
    const max = LAST_ROW + 1 - viewport
    for (let top = viewport; top < max; top += viewport) {
      w.handle.scrollTo(top)
      await w.arrive(top)
    }
    w.handle.scrollTo(max)
    await w.arrive(max)
    const framesBefore = w.shots.length
    const gone = new Set([item])
    await w.setGone(gone)
    const fresh = await freshMount(variant, max - ITEM_ROWS, 0, gone)
    const painted = w.last().text
    check(`${variant.name}: an item ${where} leaves and the pane is the frame of a fresh mount of that list, down to its last row`, w.shots.length > framesBefore && painted === fresh, `painted ${paneOf(painted)} · a fresh mount ${paneOf(fresh)}`)
    const content = w.content()
    if (where === 'inside the viewport') check(`${variant.name}: the rect of the item that left is taken when the pane is next composed, none is kept`, content !== null && pendingClears.get(content) === undefined, content === null ? 'no content box' : `${pendingClears.get(content)?.length} rects kept`)
    await w.end()
  }
}

section('6. the pane narrows and every row re-wraps, with every row painted once and none changed')
for (const variant of [TRANSCRIPT, BARE]) {
  const narrow = 12
  const w = await world(variant)
  const viewport = w.handle.getViewportHeight()
  const max = LAST_ROW + 1 - viewport
  for (let top = viewport; top < max; top += viewport) {
    w.handle.scrollTo(top)
    await w.arrive(top)
  }
  w.handle.scrollTo(max)
  await w.arrive(max)
  await w.resize(ROWS, narrow)
  const top = w.handle.getScrollTop()
  const painted = w.last().text
  const fresh = await freshMount(variant, top, 0, NONE, narrow)
  const paneRows = (text: string): string[] => text.split('\n').slice(1, -1).map(row => row.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+$/, ''))
  const blank = paneRows(painted).filter(row => row === '').length
  check(`${variant.name}: at ${narrow} columns the pane is the frame of a fresh mount there, no row of it blank`, painted === fresh && blank <= variant.paddingTop, `${blank} blank rows; painted ${JSON.stringify(paneRows(painted).slice(0, 4))} … · a fresh mount ${JSON.stringify(paneRows(fresh).slice(0, 4))} …`)
  await w.end()
}

section('7. every scroll box under src and its vertical padding')
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.tsx')) files.push(path)
    }
  }
  walk(SRC)
  const openings = (source: string): string[] => {
    const found: string[] = []
    const opener = /<ScrollBox(?=[\s/>])/g
    for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
      let depth = 0
      let at = match.index + match[0].length
      for (; at < source.length; at++) {
        const char = source[at]!
        if (char === '{') depth++
        else if (char === '}') depth--
        else if (char === '>' && depth === 0) break
      }
      found.push(source.slice(match.index, at + 1))
    }
    return found
  }
  const padded: Record<string, string[]> = {}
  let boxes = 0
  for (const file of files) {
    for (const tag of openings(readFileSync(file, 'utf8'))) {
      boxes++
      const names = [...tag.matchAll(/\b(padding|paddingY|paddingTop|paddingBottom)\s*=/g)].map(match => match[1]!)
      if (/\{\s*\.\.\./.test(tag)) names.push('a spread')
      if (names.length > 0) (padded[relative(SRC, file).split(sep).join('/')] ??= []).push(...names)
    }
  }
  check(`the walk reads the tree (${boxes} scroll boxes in ${files.length} files)`, boxes >= 15, `${boxes} boxes`)
  check('the transcript pane is the one scroll box with vertical padding, so the one whose padding row holds content when scrolled', JSON.stringify(padded) === JSON.stringify(PADDED_BOXES), JSON.stringify(padded))
}

console.log(`\nscroll-clip-paints: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
