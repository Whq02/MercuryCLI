#!/usr/bin/env bun
process.env.TERM_PROGRAM = 'Apple_Terminal'

const { CharPool, HyperlinkPool, StylePool, charInCellAt, createScreen, setCellAt } = await import('../../src/ink/cell-grid.ts')
const { shapeBidiForTerminal } = await import('../../src/ink/bidi.ts')
const { terminalBidiFrame } = await import('../../src/ink/terminalBidiFrame.ts')
type Screen = import('../../src/ink/cell-grid.ts').Screen
type Frame = import('../../src/ink/frame.ts').Frame

const COLS = 40
const ROWS = 6
const NARROW = 0
const LATIN = ['a plain row of the transcript', 'another row, still left to right', '', 'numbers 123 and a box │ rule ─', 'the fifth row', 'foot']
const ARABIC = 'تفلسف means philosophising'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const styles = new StylePool()

function writeRow(screen: Screen, y: number, line: string): void {
  const glyphs = Array.from(line.padEnd(COLS, ' ')).slice(0, COLS)
  glyphs.forEach((char, x) => setCellAt(screen, x, y, { char, styleId: styles.none, width: NARROW, hyperlink: undefined }))
}

function screenOf(lines: string[], glyphPool = new CharPool()): Screen {
  const screen = createScreen(COLS, ROWS, styles, glyphPool, new HyperlinkPool())
  lines.forEach((line, y) => writeRow(screen, y, line))
  return screen
}

function watched(screen: Screen): { frame: Frame; reads: () => number } {
  let reads = 0
  const cells = new Proxy(screen.cells, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  const frame: Frame = { screen: { ...screen, cells }, viewport: { width: COLS, height: ROWS }, cursor: { x: 0, y: 0, visible: false } }
  return { frame, reads: () => reads }
}

const rowText = (screen: Screen, y: number): string => Array.from({ length: COLS }, (_, x) => charInCellAt(screen, x, y) ?? ' ').join('')

{
  const first = watched(screenOf(LATIN))
  const out = terminalBidiFrame(first.frame)
  t('§1 a screen whose glyphs hold no right-to-left letter comes back as it went in', out === first.frame)
  t('§1 and no cell of it is read to learn that', first.reads() === 0, `${first.reads()} cell reads on a ${COLS}x${ROWS} screen`)
  const second = watched(first.frame.screen)
  t('§1 nor on the next frame of the same pool', terminalBidiFrame(second.frame) === second.frame && second.reads() === 0, `${second.reads()} cell reads`)
}

{
  const lines = [...LATIN]
  lines[2] = ARABIC
  const source = screenOf(lines)
  const probe = watched(source)
  const out = terminalBidiFrame(probe.frame)
  const cellsOfRow = Array.from(ARABIC.padEnd(COLS, ' ')).slice(0, COLS).map(value => ({ value, width: 1 as const, styleId: styles.none, hyperlink: undefined }))
  const shaped = shapeBidiForTerminal(cellsOfRow).map(cell => cell.value).join('')
  t('§2 a row that holds right-to-left letters is shaped as the shaper alone shapes it', out !== probe.frame && rowText(out.screen, 2) === shaped && shaped !== rowText(source, 2), `painted ${JSON.stringify(rowText(out.screen, 2))}\nshaper  ${JSON.stringify(shaped)}`)
  t('§2 every other row of that frame is the source row', [0, 1, 3, 4, 5].every(y => rowText(out.screen, y) === rowText(source, y)))
  t('§2 and the source screen is not written', rowText(source, 2) === ARABIC.padEnd(COLS, ' '))
}

{
  const glyphPool = new CharPool()
  const screen = screenOf(LATIN, glyphPool)
  const before = watched(screen)
  const untouched = terminalBidiFrame(before.frame) === before.frame
  writeRow(screen, 4, ARABIC)
  const after = watched(screen)
  const out = terminalBidiFrame(after.frame)
  t('§3 a right-to-left letter that enters the pool after the pass first looked is seen on the next frame', untouched && out !== after.frame && rowText(out.screen, 4) !== rowText(screen, 4), `first frame untouched ${untouched}, second frame shaped ${out !== after.frame}`)
}

{
  const glyphPool = new CharPool()
  const screen = screenOf(LATIN, glyphPool)
  writeRow(screen, 4, ARABIC)
  writeRow(screen, 4, LATIN[4]!)
  const probe = watched(screen)
  const out = terminalBidiFrame(probe.frame)
  t('§4 a pool that still holds such a letter while no row shows one: the screen is read and comes back as it went in', out === probe.frame && probe.reads() >= COLS * ROWS, `${probe.reads()} cell reads, same frame ${out === probe.frame}`)
}

{
  process.env.TERM_PROGRAM = 'xterm'
  const lines = [...LATIN]
  lines[2] = ARABIC
  const probe = watched(screenOf(lines))
  t('§5 a terminal that shapes its own rows gets no pass at all', terminalBidiFrame(probe.frame) === probe.frame && probe.reads() === 0, `${probe.reads()} cell reads`)
  process.env.TERM_PROGRAM = 'Apple_Terminal'
}

console.log(failures === 0 ? 'RTL PASS READS: ALL PASS' : 'RTL PASS READS: RED')
process.exit(failures)
