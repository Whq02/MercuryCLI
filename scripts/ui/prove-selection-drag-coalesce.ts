#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-drag-coalesce-'))
mkdirSync(join(SCRATCH, 'config'), { recursive: true })
writeFileSync(join(SCRATCH, 'config', '.mercury.json'), JSON.stringify({ copyOnSelect: false, hasCompletedOnboarding: true }))
process.env.HOME = SCRATCH
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_TERMINAL_TITLE = '0'
delete process.env.NODE_ENV

const React = await import('react')
const { enableConfigs } = await import(`${ROOT}/src/utils/config.js`)
enableConfigs()
const { render, Box, Text } = (await import(`${ROOT}/src/ink.js`)) as {
  render: (node: unknown, opts: Record<string, unknown>) => Promise<{ unmount: () => void }>
  Box: unknown
  Text: unknown
}
const { AlternateScreen } = await import(`${ROOT}/src/ink/components/AlternateScreen.js`)
const { default: ScrollBox } = await import(`${ROOT}/src/ink/components/ScrollBox.js`)
const { default: instances } = await import(`${ROOT}/src/ink/instances.js`)
const { default: useInput } = await import(`${ROOT}/src/ink/hooks/use-input.js`)
const { lastComposeCounts } = await import(`${ROOT}/src/ink/compose-buffer.js`)
const { AppStateProvider } = await import(`${ROOT}/src/state/AppState.js`)
const { default: ScrollKeybindingHandler } = await import(`${ROOT}/src/components/ScrollKeybindingHandler.js`)
type ScrollHandle = { getScrollTop: () => number; getViewportTop: () => number; getViewportHeight: () => number; getPendingDelta: () => number }
const { AnsiEmulator, defaultSgr } = await import('../ink-runtime/ansiEmulator.js')
type SgrState = ReturnType<typeof defaultSgr>

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const COLS = 120
const ROWS = 40

class FakeStdout extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  chunks: string[] = []
  write(chunk: string | Buffer, enc?: unknown, cb?: () => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    if (typeof enc === 'function') (enc as () => void)()
    else cb?.()
    return true
  }
}
const stdout = new FakeStdout()
const stderr = new FakeStdout()
const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream
const push = (s: string): void => {
  ;(stdin as unknown as Readable).push(s)
}

let frames = 0
const durations: number[] = []
const onFrame = (ev: { durationMs: number }): void => {
  frames++
  durations.push(ev.durationMs)
}

function forGlass(bytes: string): string {
  return bytes
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[<>=][0-9;:]*[A-Za-z]/g, '')
    .replace(/\x1b\[\?[0-9;]*\$p/g, '')
    .replace(/\x1b\[\?[0-9;]*[nu]/g, '')
    .replace(/\x1b\[[0-9;]*[cn]/g, '')
    .replace(/\x1b\[[0-9;]* q/g, '')
    .replace(/\x1b\[!p/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/\x1b\([0-9A-B]/g, '')
}
const glass = new AnsiEmulator(COLS, ROWS, true)
let fed = 0
let glassFault = ''
function flushGlass(): void {
  if (fed >= stdout.chunks.length) return
  const bytes = stdout.chunks.slice(fed).join('')
  fed = stdout.chunks.length
  try {
    glass.feed(forGlass(bytes))
  } catch (e) {
    glassFault ||= e instanceof Error ? e.message : String(e)
  }
}
function visibleKey(ch: string, st: SgrState | null): string {
  const s = st ?? defaultSgr()
  if (ch === ' ') return ` |${s.bg}|${s.inverse}|${s.underline}|${s.strike}`
  return `${ch}|${s.bold}|${s.dim}|${s.italic}|${s.underline}|${s.inverse}|${s.strike}|${s.fg}|${s.bg}`
}
function snapshot(): string[] {
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) out.push(visibleKey(glass.grid[y]![x]!, glass.styleAt(x, y)))
  return out
}
function glassRowText(y: number): string {
  return glass.rowText(y)
}
function rowWith(needle: string): number {
  for (let y = 0; y < ROWS; y++) if (glassRowText(y).includes(needle)) return y
  return -1
}

const h = React.createElement as (...a: unknown[]) => unknown
const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
const rowText = (i: number): string =>
  `${String(i).padStart(3, '0')} ${W[i % 12]} ${W[(i * 5 + 3) % 12]} ${'▪'.repeat(1 + ((i * 7) % 30))} ${W[(i * 11 + 7) % 12]} the quick brown fox jumps over the lazy dog`
const TAIL_MARK = 'tailrow'
const TRANSCRIPT_ROWS = 400
let setTailText: ((t: string) => void) | null = null
function Tail(): unknown {
  const [text, setText] = React.useState(`${TRANSCRIPT_ROWS - 1} ${TAIL_MARK} one the quick brown fox jumps over the lazy dog`)
  setTailText = setText
  return h(Text as never, { color: 'cyan' }, text)
}
let setStreamedRows: ((n: number) => void) | null = null
function Streamed(): unknown {
  const [n, setN] = React.useState(0)
  setStreamedRows = setN
  return h(React.Fragment as never, {}, ...Array.from({ length: n }, (_, i) => h(Text as never, { key: `s${i}` }, `streamed line ${i} arrives under the selection`)))
}
let keyLanded: ((input: string, atMs: number) => void) | null = null
function RawModeHolder(): null {
  useInput(input => {
    keyLanded?.(input, performance.now())
  })
  return null
}
const transcript = Array.from({ length: TRANSCRIPT_ROWS - 1 }, (_, i) =>
  h(Text as never, { key: `t${i}`, ...(i % 5 === 0 ? { color: 'cyan' } : i % 7 === 0 ? { bold: true } : {}) }, rowText(i)),
)
transcript.push(h(Tail as never, { key: 'tail' }))
transcript.push(h(Streamed as never, { key: 'streamed' }))
const rail = (tag: string): unknown =>
  h(
    Box as never,
    { width: 24, flexShrink: 0, flexDirection: 'column', borderStyle: 'round' },
    ...Array.from({ length: 30 }, (_, i) => h(Text as never, { key: `${tag}${i}`, dimColor: i % 3 === 0 }, `${tag} row ${i} · steady`)),
  )
const scrollRef = React.createRef<ScrollHandle>()
const tree = h(
  AppStateProvider as never,
  {},
  h(
    AlternateScreen as never,
    { mouseTracking: true },
    h(
      Box as never,
      { flexDirection: 'column', width: COLS, height: ROWS },
      h(
        Box as never,
        { flexDirection: 'row', flexGrow: 1 },
        rail('left'),
        h(Box as never, { flexGrow: 1, flexDirection: 'column', borderStyle: 'round' }, h(ScrollBox as never, { ref: scrollRef, flexGrow: 1, flexDirection: 'column', stickyScroll: true }, ...transcript)),
        rail('right'),
      ),
      h(Box as never, { height: 3, borderStyle: 'round', flexShrink: 0 }, h(Text as never, {}, 'composer › type here'), h(RawModeHolder as never, {})),
      h(ScrollKeybindingHandler as never, { scrollRef, isActive: true }),
    ),
  ),
)

const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))
const twoTicks = async (): Promise<void> => {
  await tick()
  await tick()
}

const instance = await render(tree, { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false, onFrame })
await settle(300)
type Ink = {
  onRender: () => void
  forceRedraw: () => void
  clearTextSelection: () => void
  selection: { anchor: { col: number; row: number } | null; focus: { col: number; row: number } | null; isDragging: boolean; anchorSpan: { kind: string } | null }
}
const ink = instances.get(stdout as never) as unknown as Ink | undefined
if (!ink) {
  console.error('no ink instance registered for the fake stdout (a mount error unmounts and deletes it)')
  console.error(stderr.chunks.join('').slice(0, 2000))
  process.exit(2)
}
flushGlass()

type Cell = { col: number; row: number }
const sgr = (b: number, c: Cell, release = false): string => `\x1b[<${b};${c.col + 1};${c.row + 1}${release ? 'm' : 'M'}`
const LEFT = 0
const MOTION = 0x20
const PANE_C0 = 26
const PANE_C1 = 94
const tailRow = (() => {
  for (let y = 0; y < ROWS; y++) if (glassRowText(y).includes(TAIL_MARK)) return y
  return -1
})()
check('the transcript tail is on the glass', tailRow > 0, `tailRow=${tailRow}; fault=${glassFault}`)
const ANCHOR: Cell = { col: 30, row: Math.max(1, tailRow - 8) }
function focusAt(k: number): Cell {
  const perRow = PANE_C1 - PANE_C0 + 1
  const start = ANCHOR.col - PANE_C0 + 1 + k
  return { col: PANE_C0 + (start % perRow), row: Math.min(ANCHOR.row + Math.floor(start / perRow), tailRow) }
}
const same = (a: Cell | null, b: Cell): boolean => a !== null && a.col === b.col && a.row === b.row
const styleKey = (c: Cell): string => {
  const s = glass.styleAt(c.col, c.row) ?? defaultSgr()
  return `${s.bg}|${s.inverse}`
}
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]! : 0
}

async function pressAt(c: Cell): Promise<number> {
  await settle(600)
  const f0 = frames
  push(sgr(LEFT, c))
  await twoTicks()
  return frames - f0
}
async function releaseAt(c: Cell): Promise<number> {
  const f0 = frames
  push(sgr(LEFT, c, true))
  await twoTicks()
  return frames - f0
}
async function clearAll(): Promise<void> {
  ink!.clearTextSelection()
  await twoTicks()
}
async function glassEqualsRedraw(label: string): Promise<void> {
  await twoTicks()
  flushGlass()
  const before = snapshot()
  ink!.forceRedraw()
  await twoTicks()
  flushGlass()
  const after = snapshot()
  const diffs: string[] = []
  for (let i = 0; i < before.length && diffs.length < 3; i++) {
    if (before[i] !== after[i]) diffs.push(`(${i % COLS},${Math.floor(i / COLS)}) ${before[i]} → ${after[i]}`)
  }
  check(`${label}: the glass equals a forced full redraw`, diffs.length === 0 && glassFault === '', glassFault || diffs.join('; '))
}

section('§1 coalescing — a chunk of drag reports paints once, at its last position')
{
  const pressFrames = await pressAt(ANCHOR)
  check('a press paints one frame', pressFrames === 1, `${pressFrames} frames`)
  const N = 200
  const motions = Array.from({ length: N }, (_, k) => sgr(LEFT | MOTION, focusAt(k)))
  let f0 = frames
  push(motions.join(''))
  await twoTicks()
  check(`${N} drag reports in one chunk paint at most one frame`, frames - f0 <= 1, `${frames - f0} frames`)
  const last = focusAt(N - 1)
  check('the coalesced frame carries the final focus', same(ink.selection.focus, last), JSON.stringify(ink.selection.focus))
  flushGlass()
  const beyond: Cell = { col: last.col + 1, row: last.row }
  const highlight = styleKey(last)
  check('the glass highlights the final focus cell and not the cell beyond it', highlight !== styleKey(beyond), `focus ${highlight} beyond ${styleKey(beyond)}`)

  f0 = frames
  push(sgr(LEFT | MOTION, last))
  await twoTicks()
  check('a report for the cell already focused paints nothing', frames - f0 === 0, `${frames - f0} frames`)
  check('a release paints one frame', (await releaseAt(last)) === 1)
  await clearAll()

  const word: Cell = { col: 30, row: ANCHOR.row }
  await settle(600)
  push(sgr(LEFT, word))
  await twoTicks()
  push(sgr(LEFT, word, true))
  await twoTicks()
  push(sgr(LEFT, word))
  await twoTicks()
  check('a double-click selects a word', ink.selection.anchorSpan?.kind === 'word', JSON.stringify(ink.selection.anchorSpan))
  f0 = frames
  push(sgr(LEFT | MOTION, { col: word.col + 1, row: word.row }))
  await twoTicks()
  check('a word-mode report inside the selected word paints nothing', frames - f0 === 0, `${frames - f0} frames`)
  f0 = frames
  push(sgr(LEFT | MOTION, { col: word.col + 15, row: word.row }))
  await twoTicks()
  check('a word-mode report into a later word paints one frame', frames - f0 === 1, `${frames - f0} frames`)
  await releaseAt({ col: word.col + 15, row: word.row })
  await clearAll()
}

section('§2 the blit survives — a drag frame composes no text and costs a steady frame')
{
  const N = 200
  await pressAt(ANCHOR)
  const d0 = durations.length
  let composedText = 0
  let blitMissing = 0
  for (let k = 0; k < N; k++) {
    push(sgr(LEFT | MOTION, focusAt(k)))
    await tick()
    if (lastComposeCounts.write > 0) composedText++
    if (lastComposeCounts.blit === 0) blitMissing++
  }
  const drag = durations.slice(d0)
  check(`${N} chunked drag reports paint ${N} frames`, drag.length === N, `${drag.length} frames`)
  check('no drag frame composes text (the blit engaged on every one)', composedText === 0 && blitMissing === 0, `composed=${composedText} blitMissing=${blitMissing}`)
  await releaseAt(focusAt(N - 1))
  await clearAll()
  const s0 = durations.length
  for (let i = 0; i < N; i++) ink.onRender()
  const steady = durations.slice(s0)
  const dragP50 = pct(drag, 50)
  const steadyP50 = pct(steady, 50)
  const bound = Math.max(5 * steadyP50, 0.5)
  check(
    'a drag frame\'s median cost stays in the steady frame\'s class (≤ 5×, 0.5 ms floor)',
    dragP50 <= bound,
    `drag p50 ${dragP50.toFixed(3)} ms vs steady p50 ${steadyP50.toFixed(3)} ms (bound ${bound.toFixed(3)} ms)`,
  )
  console.log(`  drag p50 ${dragP50.toFixed(3)} ms · p95 ${pct(drag, 95).toFixed(3)} ms · steady p50 ${steadyP50.toFixed(3)} ms`)
}

section('§3 the ghosts — the glass equals a full redraw after every step')
{
  await pressAt(ANCHOR)
  push(Array.from({ length: 60 }, (_, k) => sgr(LEFT | MOTION, focusAt(k))).join(''))
  await glassEqualsRedraw('grow to sixty cells')
  push(sgr(LEFT | MOTION, focusAt(9)))
  await glassEqualsRedraw('shrink to ten cells')
  flushGlass()
  const vacated = focusAt(30)
  check('the vacated cell carries no highlight after the shrink', styleKey(vacated) !== styleKey(focusAt(5)), `vacated ${styleKey(vacated)} vs selected ${styleKey(focusAt(5))}`)
  push(Array.from({ length: 700 }, (_, k) => sgr(LEFT | MOTION, focusAt(k))).join(''))
  await twoTicks()
  check('the selection reaches the tail row', ink.selection.focus?.row === tailRow, JSON.stringify(ink.selection.focus))
  setTailText?.(`199 ${TAIL_MARK} CHANGED the quick brown fox jumps over the lazy dog`)
  await settle(50)
  await glassEqualsRedraw('content change under the selection')
  flushGlass()
  check('the glass shows the changed tail text', rowWith('CHANGED') >= 0, glassRowText(tailRow).slice(24, 80))
  await releaseAt(focusAt(699))
  await clearAll()
  await glassEqualsRedraw('clear')
  flushGlass()
  let highlighted = 0
  const plain = styleKey({ col: 40, row: ANCHOR.row })
  for (let y = 1; y < tailRow; y++) for (let x = PANE_C0; x <= PANE_C1; x++) if (styleKey({ col: x, row: y }) !== plain) highlighted++
  check('no transcript cell carries a highlight after the clear', highlighted === 0, `${highlighted} cells`)
}

section('§4 scroll under a drag — the tick scrolls, motion reports never do; the highlight follows the text')
{
  const handle = scrollRef.current
  check('the transcript exposes its scroll handle', handle !== null, 'scrollRef.current is null')
  const viewportTop = handle?.getViewportTop() ?? 1
  const paneRows = handle?.getViewportHeight() ?? 0
  check('the pane fills the transcript box', paneRows > 20 && viewportTop >= 1, `viewportTop=${viewportTop} height=${paneRows}`)
  const plainKey = styleKey({ col: 40, row: tailRow })
  const highlightedRows = (): number[] => {
    const rows: number[] = []
    for (let y = 0; y < ROWS; y++) {
      let n = 0
      for (let x = PANE_C0; x <= PANE_C1; x++) if (styleKey({ col: x, row: y }) !== plainKey && glass.grid[y]![x] !== ' ') n++
      if (n > 0) rows.push(y)
    }
    return rows
  }
  const scrollTop = (): number => handle?.getScrollTop() ?? -1
  const full = handle as unknown as { getScrollHeight: () => number; scrollBy: (dy: number) => void; scrollToBottom: () => void } | null
  const facts = (): string =>
    `scrollTop=${scrollTop()} height=${full?.getScrollHeight()} viewport=${viewportTop}+${paneRows} pending=${handle?.getPendingDelta()} dragging=${ink.selection.isDragging} anchor=${JSON.stringify(ink.selection.anchor)} focus=${JSON.stringify(ink.selection.focus)} fault=${glassFault || 'none'}`
  const tailRows = (): string => [ROWS - 8, ROWS - 7, ROWS - 6, ROWS - 5, ROWS - 4].map(y => `${y}:${JSON.stringify(glassRowText(y).slice(PANE_C0, PANE_C0 + 40))}`).join(' ')
  flushGlass()
  console.log(`  at entry: ${facts()}`)
  console.log(`  glass tail rows: ${tailRows()}`)
  const TEXT_C0 = 25
  const lineStart = (y: number): boolean => /^\d{3} /.test(glassRowText(y).slice(TEXT_C0, TEXT_C0 + 4))
  let anchorRowB = viewportTop + 2
  while (anchorRowB < viewportTop + 8 && !lineStart(anchorRowB)) anchorRowB++
  const ANCHOR_B: Cell = { col: TEXT_C0 + 6, row: anchorRowB }
  const anchorLine = glassRowText(ANCHOR_B.row).slice(TEXT_C0, TEXT_C0 + 20)
  check('the anchor row is a line start carrying transcript text', lineStart(ANCHOR_B.row), JSON.stringify(anchorLine))

  const controlTop = scrollTop()
  full?.scrollBy(-4)
  await settle(60)
  flushGlass()
  check('the scroll handle scrolls the pane (the control for the tick)', controlTop - scrollTop() === 4, `scrollTop ${controlTop} → ${scrollTop()}; ${facts()}`)
  full?.scrollToBottom()
  await settle(60)

  await pressAt(ANCHOR_B)
  const above: Cell = { col: ANCHOR_B.col, row: 0 }
  const top0 = scrollTop()
  push(sgr(LEFT | MOTION, above))
  await twoTicks()
  await settle(320)
  console.log(`  after the hold: ${facts()}`)
  const heldStill = top0 - scrollTop()
  check('a pointer held still above the pane scrolls the content by the tick (≈ 2 rows per 50 ms)', heldStill >= 8 && heldStill <= 16, `${heldStill} rows in 320 ms`)
  const top1 = scrollTop()
  const t1 = performance.now()
  for (let k = 0; k < 30; k++) {
    push(sgr(LEFT | MOTION, { col: above.col + (k % 3), row: 0 }))
    await settle(5)
  }
  const elapsed = performance.now() - t1
  const heldMoving = top1 - scrollTop()
  const expected = 2 * Math.floor(elapsed / 50)
  check('thirty reports at the edge scroll the tick\'s rows, not thirty (the rate, not the count)', Math.abs(heldMoving - expected) <= 4 && heldMoving < 30, `${heldMoving} rows for 30 reports over ${elapsed.toFixed(0)} ms (tick rate ⇒ ${expected})`)

  await twoTicks()
  flushGlass()
  const anchorNow = rowWith(anchorLine)
  const rows = highlightedRows()
  check('the anchor line moved down with the scrolled content', anchorNow > ANCHOR_B.row, `anchor line ${JSON.stringify(anchorLine)} now at row ${anchorNow} (was ${ANCHOR_B.row}); scrolled ${heldStill + heldMoving} rows`)
  check('the anchor line is still highlighted at its new row (the highlight followed the text)', anchorNow >= 0 && rows.includes(anchorNow), `highlighted rows ${rows[0]}..${rows.at(-1)}, anchor at ${anchorNow}`)
  check('the highlight spans from the pane top down to the anchor line', rows.length > 0 && rows[0]! <= viewportTop && rows.at(-1)! >= anchorNow, `rows ${rows[0]}..${rows.at(-1)}, anchor at ${anchorNow}`)
  const copied = (ink as unknown as { copySelectionNoClear: () => string }).copySelectionNoClear()
  check('the copy carries the anchor line and the lines that scrolled in above it', copied.includes(anchorLine.slice(0, 6)) && copied.split('\n').length >= heldStill, `${copied.split('\n').length} lines copied; ${JSON.stringify(copied.slice(-80))}`)
  await releaseAt(above)
  await clearAll()
  ;(handle as unknown as { scrollToBottom: () => void } | null)?.scrollToBottom()
  await settle(120)

  flushGlass()
  const tailBefore = rowWith(TAIL_MARK)
  await pressAt({ col: ANCHOR.col, row: tailBefore - 2 })
  push(sgr(LEFT | MOTION, { col: ANCHOR.col + 20, row: tailBefore }))
  await twoTicks()
  await releaseAt({ col: ANCHOR.col + 20, row: tailBefore })
  flushGlass()
  const textsBefore = highlightedRows().map(y => glassRowText(y).slice(PANE_C0, PANE_C0 + 16))
  check('a selection stands on the last three lines', textsBefore.length === 3, `${textsBefore.length} rows (${highlightedRows().join(',')}); ${facts()}`)
  setStreamedRows?.(4)
  await settle(150)
  flushGlass()
  console.log(`  after the stream: ${facts()}`)
  console.log(`  glass tail rows: ${tailRows()}`)
  const textsAfter = highlightedRows().map(y => glassRowText(y).slice(PANE_C0, PANE_C0 + 16))
  check('four streamed lines scrolled the pane (the tail moved up)', rowWith(TAIL_MARK) === tailBefore - 4, `tail ${tailBefore} → ${rowWith(TAIL_MARK)}`)
  check('the same lines stay highlighted after the stream (the follow translation)', JSON.stringify(textsAfter) === JSON.stringify(textsBefore), `before ${JSON.stringify(textsBefore)} after ${JSON.stringify(textsAfter)}`)
  await clearAll()
  flushGlass()
  const tail2 = rowWith(TAIL_MARK)
  await pressAt({ col: ANCHOR.col, row: tail2 - 2 })
  push(sgr(LEFT | MOTION, { col: ANCHOR.col + 20, row: tail2 }))
  await twoTicks()
  flushGlass()
  const anchorText = glassRowText(tail2 - 2).slice(TEXT_C0, TEXT_C0 + 16)
  setStreamedRows?.(8)
  await settle(150)
  flushGlass()
  const anchorRowNow = rowWith(anchorText)
  check('while dragging, the anchor line moved up with the stream and is still highlighted', anchorRowNow === tail2 - 6 && highlightedRows().includes(anchorRowNow), `anchor ${JSON.stringify(anchorText)} at ${anchorRowNow} (expected ${tail2 - 6}); highlighted ${highlightedRows().join(',')}`)
  await releaseAt({ col: ANCHOR.col + 20, row: tail2 })
  await clearAll()
  ;(handle as unknown as { scrollToBottom: () => void } | null)?.scrollToBottom()
  await settle(120)

  flushGlass()
  const tailForDrag = rowWith(TAIL_MARK) > 0 ? rowWith(TAIL_MARK) : tailRow
  await pressAt({ col: ANCHOR.col, row: tailForDrag - 3 })
  console.log(`  backlog leg start: ${facts()}`)
  const atom = sgr(LEFT | MOTION, { col: 40, row: 0 })
  const atomBytes = Buffer.byteLength(atom)
  const queueSamples: number[] = []
  const keyLatencies: number[] = []
  const scrollSamples: number[] = []
  let keyPushedAt = 0
  keyLanded = (input, at) => {
    if (input === 'x' && keyPushedAt > 0) {
      keyLatencies.push(at - keyPushedAt)
      keyPushedAt = 0
    }
  }
  const f0 = frames
  const t0 = performance.now()
  let k = 0
  while (performance.now() - t0 < 5000) {
    const pendingBytes = (stdin as unknown as { readableLength: number }).readableLength
    queueSamples.push(pendingBytes / atomBytes)
    push(sgr(LEFT | MOTION, { col: 40 + (k % 40), row: 0 }))
    if (k % 62 === 61) {
      keyPushedAt = performance.now()
      push('\x1bx')
      scrollSamples.push(scrollTop())
      if (scrollSamples.length === 2) console.log(`  backlog leg mid: ${facts()}`)
    }
    k++
    await settle(8)
  }
  await twoTicks()
  const worstQueue = Math.max(...queueSamples)
  check(`${k} reports over 5 s with the pane scrolling: the input queue stays ≤ 1 report at every sample`, worstQueue <= 1, `worst ${worstQueue.toFixed(2)} reports pending; ${frames - f0} frames painted`)
  check('keystrokes typed through the drag land within one frame', keyLatencies.length >= 5 && Math.max(...keyLatencies) <= 16, `${keyLatencies.length} keys, worst ${keyLatencies.length ? Math.max(...keyLatencies).toFixed(1) : 'n/a'} ms`)
  console.log(`  ${k} reports · ${frames - f0} frames · worst queue ${worstQueue.toFixed(2)} · keys ${keyLatencies.map(x => x.toFixed(1)).join(' ')} ms · scrollTop every half second ${scrollSamples.join(' ')} → ${scrollTop()}`)
  keyLanded = null
  await releaseAt({ col: 40, row: 0 })
  await clearAll()
}

instance.unmount()
if (failures > 0) {
  console.log(`\nselection drag coalesce: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nselection drag coalesce: green (${checks} checks)`)
process.exit(0)
