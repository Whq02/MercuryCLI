import { createSplashCore, HEADSTD, WORD, mixc } from '../../assets/splash/splash-core.mjs'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

type Cell = { ch: string; fg: string; bg: string }
function cellsOf(line: string, width: number): Cell[] {
  const emu = new AnsiEmulator(width, 1, true)
  emu.feed(line)
  return Array.from({ length: width }, (_, x) => {
    const st = emu.styleAt(x, 0)
    return { ch: emu.grid[0]![x]!, fg: st?.fg ?? 'default', bg: st?.bg ?? 'default' }
  })
}
type Pair = { kind: 'blank' | 'top' | 'bottom' | 'same' | 'two'; top: string; bottom: string }
function pairs(grid: string[]): Pair[][] {
  const width = Math.max(...grid.map(row => row.length))
  const rows = grid.map(row => row.padEnd(width, '.'))
  const out: Pair[][] = []
  for (let y = 0; y < rows.length; y += 2) {
    const line: Pair[] = []
    for (let x = 0; x < width; x++) {
      const top = rows[y]![x]!
      const bottom = y + 1 < rows.length ? rows[y + 1]![x]! : '.'
      const kind = top === '.' && bottom === '.' ? 'blank' : bottom === '.' ? 'top' : top === '.' ? 'bottom' : top === bottom ? 'same' : 'two'
      line.push({ kind, top, bottom })
    }
    out.push(line)
  }
  return out
}

const truecolor = createSplashCore({ truecolor: true, accent: 'crab' })
const ink: Record<string, number[]> = { E: truecolor.CREAM, e: truecolor.MIDCREAM, R: truecolor.ACCENT.main, r: truecolor.ACCENT.deep, d: mixc(truecolor.ACCENT.deep, truecolor.ACCENT.main, 0.5) }
const fgOf = (letter: string): string => `38;2;${ink[letter]!.join(';')}`
const bgOf = (letter: string): string => `48;2;${ink[letter]!.join(';')}`

console.log('\n§1 the truecolor head: every cell with two painted halves is ▄ with the lower pixel as its glyph and the upper pixel as its background')
{
  const grid = pairs(HEADSTD)
  const { lines, width } = truecolor.rasterHard(HEADSTD)
  check('the head rasters one line per pixel pair', lines.length === grid.length, `${lines.length} lines for ${grid.length} pairs`)
  const two: Array<{ x: number; y: number; cell: Cell; pair: Pair }> = []
  const wrong: string[] = []
  const others: string[] = []
  lines.forEach((line, y) => {
    const cells = cellsOf(line, width)
    grid[y]!.forEach((pair, x) => {
      const cell = cells[x]!
      if (pair.kind === 'two') {
        two.push({ x, y, cell, pair })
        if (!(cell.ch === '▄' && cell.fg === fgOf(pair.bottom) && cell.bg === bgOf(pair.top))) wrong.push(`(${x},${y}) ${cell.ch} fg ${cell.fg} bg ${cell.bg} for ${pair.top} over ${pair.bottom}`)
        return
      }
      const expected: Cell =
        pair.kind === 'blank' ? { ch: ' ', fg: 'default', bg: 'default' }
        : pair.kind === 'top' ? { ch: '▀', fg: fgOf(pair.top), bg: 'default' }
        : pair.kind === 'bottom' ? { ch: '▄', fg: fgOf(pair.bottom), bg: 'default' }
        : { ch: '█', fg: fgOf(pair.top), bg: 'default' }
      if (cell.ch !== expected.ch || cell.fg !== expected.fg || cell.bg !== expected.bg) others.push(`(${x},${y}) ${pair.kind}: ${cell.ch} fg ${cell.fg} bg ${cell.bg}`)
    })
  })
  check('the head has its seventeen two-colour cells', two.length === 17, `${two.length}`)
  check('every two-colour cell goes out as ▄, lower pixel as the glyph, upper pixel as the background', wrong.length === 0, wrong.slice(0, 4).join(' · '))
  check('no two-colour cell carries the upper pixel as its glyph over the lower pixel as its background', two.every(({ cell }) => cell.ch !== '▀'), two.filter(({ cell }) => cell.ch === '▀').length + ' as ▀')
  check('blank, top-only, bottom-only and one-colour cells keep their glyph and colours', others.length === 0, others.slice(0, 4).join(' · '))
}

console.log('\n§2 the wordmark carries no two-colour cell and is unchanged')
{
  const grid = pairs(WORD)
  check('the wordmark has no two-colour cell', grid.flat().every(pair => pair.kind !== 'two'))
  const { lines, width } = truecolor.rasterHard(WORD)
  const glyphs = lines.flatMap(line => cellsOf(line, width).map(cell => cell.ch))
  check('the wordmark is drawn with ▀ ▄ █ and spaces only, no cell with a background', glyphs.every(ch => ' ▀▄█'.includes(ch)) && lines.every(line => !line.includes('\x1b[48;')))
}

console.log('\n§3 the 256-colour and plain faces keep the upper-half glyph: without a painted background the top pixel is the one that shows')
for (const [label, core] of [['256-colour', createSplashCore({ truecolor: false, accent: 'crab' })], ['plain', createSplashCore({ nocolor: true, accent: 'crab' })]] as const) {
  const grid = pairs(HEADSTD)
  const { lines, width } = core.rasterHard(HEADSTD)
  let twoAsUpper = 0
  let withBackground = 0
  lines.forEach((line, y) => {
    const cells = cellsOf(line, width)
    grid[y]!.forEach((pair, x) => {
      if (pair.kind !== 'two') return
      if (cells[x]!.ch === '▀') twoAsUpper++
      if (cells[x]!.bg !== 'default') withBackground++
    })
  })
  check(`${label}: the seventeen two-colour cells stay ▀ with no background`, twoAsUpper === 17 && withBackground === 0, `${twoAsUpper} as ▀, ${withBackground} with a background`)
}

console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} face lower half: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
