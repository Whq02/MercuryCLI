#!/usr/bin/env bun
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixPtyDriverOrSkip } from '../lib/captureDriver.ts'
import { colorSgrSequences } from './appleTerminalReading.ts'
import { artRows, basicColourCodes, bootHandOver, colourDepthJourney, DIST, inkOf, isBlock, isHexInk, JOURNEY_MARKS, type Grid } from './colourDepthJourney.ts'

const driver = posixPtyDriverOrSkip('16-colour-paint-is-basic')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'paint-16-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'proof-home')

const cellGrid = await import('../../src/screen/renderer/cell-grid.ts')
const { AMBER, ASH, CLAW, FAINT, IVORY, SECOND, TERRA, groundFamilyFor } = await import('../../src/screen/theme/mercuryPalette.ts')
const { CRITTERS, JELLYFISH_HUE } = await import('../../src/screen/cockpit/critterData.ts')

const DEPTH = 'colorDepth, colorize and rgbSgr in src/screen/renderer/colorize.ts decide what a colour becomes at 16 colours, rgbToAnsi16 and rgbToAnsi8 in src/screen/renderer/cell-grid.ts choose the code, and the highlighter in src/platform/native/color-diff/index.ts paints through rgbSgr'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail.slice(0, 600)}`}`)
}
function section(title: string): void {
  console.log('\n' + title)
}

const INK_NAMES = ['black', 'red', 'green', 'brown', 'blue', 'magenta', 'cyan', 'white', 'brightblack', 'brightred', 'brightgreen', 'brightbrown', 'brightblue', 'brightmagenta', 'brightcyan', 'brightwhite']
const BASIC = new Set(['default', ...INK_NAMES])
const PLANES = ['fg', 'bg'] as const
const CANVAS = inkOf(groundFamilyFor('dark').NIGHT)
const QUERY = Buffer.from('\x1b[>0q', 'latin1')
const channels = (color: string): [number, number, number] => {
  const ink = inkOf(color)
  return [parseInt(ink.slice(0, 2), 16), parseInt(ink.slice(2, 4), 16), parseInt(ink.slice(4, 6), 16)]
}
const hexOf = (index: number): string => (cellGrid.xterm256ToRgb(index) ?? [0, 0, 0]).map(v => v.toString(16).padStart(2, '0')).join('')
const glyph = (cell: { c: string } | undefined): string => cell?.c || ' '
const sameGlyph = (a: string, b: string): boolean => a === b || ((a === '▀' || a === '▄') && (b === '▀' || b === '▄'))
const tally = (inks: Iterable<string>): string => {
  const counts = new Map<string, number>()
  for (const ink of inks) counts.set(ink, (counts.get(ink) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ink, n]) => `${ink}×${n}`).join(' ')
}

console.log('prove-16-colour-paint-is-basic — at TERM=xterm and TERM=linux the app writes basic colour codes only, chosen from the theme\'s own colours')

const full = await colourDepthJourney(driver, scratch, 'truecolor', { TERM: 'xterm-256color', COLORTERM: 'truecolor' })
const indexed = await colourDepthJourney(driver, scratch, 'xterm-256color', { TERM: 'xterm-256color' })
const basics = [await colourDepthJourney(driver, scratch, 'xterm', { TERM: 'xterm' }), await colourDepthJourney(driver, scratch, 'linux', { TERM: 'linux' })]
const framesOf = (arm: { marks: Map<string, Grid> }): Array<{ mark: string; f: Grid; l: Grid }> => JOURNEY_MARKS.flatMap(mark => {
  const f = full.marks.get(mark)
  const l = arm.marks.get(mark)
  return f && l ? [{ mark, f, l }] : []
})

section('§1 the journey ran at 24 bits, at 256, at TERM=xterm and at TERM=linux: the first-run theme step, the Boot face, the first session screen')
for (const arm of [full, indexed, ...basics]) {
  check(`${arm.name}: the capture ended cleanly with its three marks`, arm.status === 0 && JOURNEY_MARKS.every(mark => arm.marks.has(mark)), `the capture exited ${arm.status} with marks ${[...arm.marks.keys()].join(',')}; build dist/mercury.mjs with bun run build.ts and read ${arm.name}.log under ${scratch}: ${arm.log.slice(-300)}`)
  if (arm === full) continue
  for (const { mark, f, l } of framesOf(arm)) {
    const differ = f.flatMap((row, y) => row.filter((cell, x) => !sameGlyph(glyph(cell), glyph(l[y]?.[x])))).length
    check(`${arm.name} ${mark}: the glyphs are the 24-bit screen's cell for cell, a half block for a half block`, differ === 0, `${differ} cells differ; the colour depth must not change a glyph: compare truecolor.json and ${arm.name}.json under ${scratch}`)
  }
}

for (const arm of basics) {
  section(`§2 TERM=${arm.name}: every colour code the app writes is basic`)
  const at = Buffer.from(arm.bytes).indexOf(QUERY)
  const app = at < 0 ? arm.bytes : arm.bytes.subarray(at)
  check('the app asked its first query, so the bytes after it are the app\'s own', at >= 0, `ESC [ > 0 q is not in the stream of ${arm.name}.tee.bin under ${scratch}; the split point of this proof moved`)
  const deep = colorSgrSequences(app)
  const wide = deep.filter(s => s.kind === '24-bit').length
  const narrow = deep.filter(s => s.kind === '256').length
  check(`no 38;2 or 48;2 code (${wide})`, wide === 0, `${wide} 24-bit codes: ${JSON.stringify(deep.filter(s => s.kind === '24-bit').slice(0, 3))}; ${DEPTH}`)
  check(`no 38;5 or 48;5 code (${narrow})`, narrow === 0, `${narrow} indexed codes: ${JSON.stringify(deep.filter(s => s.kind === '256').slice(0, 4))}; ${DEPTH}`)
  const basic = basicColourCodes(app)
  check(`basic codes carry the paint (${basic})`, basic > 100, `only ${basic} basic colour codes; the screens of ${arm.name} lost their colour: ${DEPTH}`)
  for (const { mark, l } of framesOf(arm)) {
    const strange = l.flatMap(row => row.flatMap(cell => PLANES.map(plane => cell[plane]).filter(ink => !BASIC.has(ink))))
    check(`${mark}: every cell's ink is one of the sixteen or the terminal's own (${strange.length} are not)`, strange.length === 0, `${tally(strange)}; ${DEPTH}`)
  }

  section(`§3 TERM=${arm.name}: the muted ink is bright black, and no letter is lost in its ground`)
  let muted = 0
  for (const { mark, f, l } of framesOf(arm)) {
    const inks = f.flatMap((row, y) => row.flatMap((cell, x) => (cell.fg === inkOf(FAINT) && glyph(cell) !== ' ' ? [l[y]?.[x]?.fg ?? 'absent'] : [])))
    muted += inks.length
    const other = inks.filter(ink => ink !== 'brightblack')
    check(`${mark}: every cell in the muted ink ${FAINT} is bright black (${inks.length} cells)`, other.length === 0, `${other.length} cells are ${tally(other)}; ${DEPTH}`)
    const lost = f.flatMap((row, y) => row.flatMap((cell, x) => {
      const got = l[y]?.[x]
      const letter = glyph(cell) !== ' ' && !isBlock(cell) && cell.fg !== cell.bg
      return letter && got && (got.fg === got.bg || (got.fg === 'black' && got.bg === 'default')) ? [`${y}:${x} '${glyph(cell)}' ${cell.fg}/${cell.bg}→${got.fg}/${got.bg}`] : []
    }))
    check(`${mark}: no letter has one ink over and under it`, lost.length === 0, `${lost.length} cells: ${lost.slice(0, 5).join(' · ')}; ${DEPTH}`)
  }
  check(`the muted ink is on the journey's screens (${muted} cells)`, muted >= 40, `only ${muted} cells carry ${FAINT} at 24 bits; the journey in scripts/ui/colourDepthJourney.ts no longer reaches a screen that paints it`)
}

section('§4 TERM=xterm-256color: the screen is the 256 paint, each plane its 24-bit ink through rgbToXterm256')
for (const { mark, f, l } of framesOf(indexed).filter(frame => frame.mark !== 'theme')) {
  const wrong: string[] = []
  let coloured = 0
  f.forEach((row, y) => row.forEach((cell, x) => {
    for (const plane of PLANES) {
      const want = cell[plane]
      const got = l[y]?.[x]?.[plane] ?? 'absent'
      if (!isHexInk(want)) {
        if (want !== got) wrong.push(`${y}:${x} ${plane} ${want}→${got}`)
        continue
      }
      coloured++
      if (plane === 'bg' && got === 'default' && want === CANVAS) continue
      const nearest = hexOf(cellGrid.rgbToXterm256(...channels(want)))
      if (got !== nearest) wrong.push(`${y}:${x} ${plane} ${want}→${got}, nearest ${nearest}`)
    }
  }))
  check(`${mark}: every coloured plane is its 24-bit ink through rgbToXterm256 (${coloured} planes)`, coloured > 50 && wrong.length === 0, `${wrong.length} planes differ: ${wrong.slice(0, 5).join(' · ')}; the 256 paint of src/screen/renderer/colorize.ts must not move with the 16 paint`)
}

section('§5 the sixteen: the Linux console\'s own palette, the theme\'s anchors, and the three a plain distance gets wrong')
{
  const console16 = ['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff']
  const own = console16.map(color => cellGrid.rgbToAnsi16(...channels(color)))
  check('each of the Linux console\'s sixteen colours is its own code', own.every((code, index) => code === index), `rgbToAnsi16 gives ${own.join(',')}; the palette in src/screen/renderer/cell-grid.ts must be the Linux console's`)
  const pins: Array<[string, string, number, string]> = [
    ['muted', FAINT, 8, '1.35 to 4.9'], ['secondary', SECOND, 7, '1 to 4.9'], ['ivory', IVORY, 15, '1 to 4.9'], ['the brand red', TERRA, 9, '1 to 4.9'], ['the crab\'s deep red', CLAW, 1, '1 to 4.9'],
    ['amber', AMBER, 3, '2.85 to 4.9'], ['the jellyfish\'s blue', JELLYFISH_HUE, 6, '1.95 to 4.9'],
  ]
  for (const [word, color, want, range] of pins) {
    const got = cellGrid.rgbToAnsi16(...channels(color))
    check(`${word} ${color} is ${want} (${INK_NAMES[want]})`, got === want, `rgbToAnsi16 gives ${got} (${INK_NAMES[got]}); the chroma weight of the sixteen in src/screen/renderer/cell-grid.ts holds this pin from ${range}`)
  }
  const ground = cellGrid.rgbToAnsi8(...channels(ASH))
  check(`the surface ${ASH} as a ground is 0 (black), never blue`, ground === 0, `rgbToAnsi8 gives ${ground} (${INK_NAMES[ground]}); the chroma weight of the sixteen in src/screen/renderer/cell-grid.ts holds this pin from 1.15 up`)
}

for (const arm of basics) {
  section(`§6 TERM=${arm.name}: the Boot face and the first session screen through one mapper`)
  for (const { mark, f, l } of framesOf(arm).filter(frame => frame.mark !== 'theme')) {
    const wrong: string[] = []
    let coloured = 0
    let turned = 0
    const chosen = l.findIndex(row => row.some(cell => cell.c === '❯'))
    const core = new Set(mark === 'boot' ? [...artRows(l).critter, ...artRows(l).wordmark, chosen] : [])
    if (mark === 'boot') {
      const label = (l[chosen] ?? []).filter(cell => /[A-Za-z]/.test(cell.c))
      check(`boot: the head, the wordmark and the selected row are the splash core's own 16 tier (${core.size} rows), the selected label bright white`, core.size > 10 && label.length > 3 && label.every(cell => cell.fg === 'brightwhite'), `the selected row reads ${[...new Set(label.map(cell => cell.fg))].join(',')}; splashCoreFor in src/screen/widgets/useSplashCoreAccent.ts must hand the Boot screens the splash core's 16 tier when colorDepth() is 16`)
    }
    f.forEach((row, y) => row.forEach((cell, x) => {
      if (core.has(y)) return
      if (glyph(cell) !== glyph(l[y]?.[x])) {
        turned++
        return
      }
      for (const plane of PLANES) {
        const want = cell[plane]
        const got = l[y]?.[x]?.[plane] ?? 'absent'
        if (!isHexInk(want)) {
          if (want !== got) wrong.push(`${y}:${x} ${plane} ${want}→${got}`)
          continue
        }
        coloured++
        if (plane === 'bg' && got === 'default' && want === CANVAS) continue
        const code = plane === 'fg' ? cellGrid.rgbToAnsi16(...channels(want)) : cellGrid.rgbToAnsi8(...channels(want))
        if (got !== INK_NAMES[code]) wrong.push(`${y}:${x} ${plane} ${want}→${got}, nearest ${INK_NAMES[code]}`)
      }
    }))
    check(`${mark}: every coloured plane is its 24-bit ink through rgbToAnsi16, a ground through the eight (${coloured} planes; ${turned} half blocks turned over and ${core.size} rows of the splash core's own tier are not read)`, coloured > 50 && turned <= 8 && wrong.length === 0, `${wrong.length} planes differ: ${wrong.slice(0, 5).join(' · ')}; ${DEPTH}`)
  }
}

section('§7 TERM=xterm: the launcher\'s last frame and the app\'s Boot face are one picture, the head and the wordmark')
for (const critter of CRITTERS) {
  const hand = await bootHandOver(driver, scratch, `hand-over-${critter.name}`, { TERM: 'xterm', MERCURY_CRITTER: critter.name })
  const last = Math.max(-1, ...artRows(hand.boot).wordmark)
  const painted = basicColourCodes(hand.app)
  check(`${critter.name}: the launch reached the Boot face and the app painted it (${painted} basic codes of its own, the wordmark ends on row ${last})`, hand.status === 0 && painted > 100 && last > 10 && hand.splash.length === hand.boot.length, `the capture exited ${hand.status}; read hand-over-${critter.name}.log under ${scratch}: ${hand.log.slice(-300)}`)
  const moved = hand.boot.slice(0, last + 1).flatMap((row, y) => row.flatMap((cell, x) => {
    const was = hand.splash[y]?.[x]
    return was !== undefined && glyph(was) === glyph(cell) && was.fg === cell.fg && was.bg === cell.bg ? [] : [`${y}:${x} '${glyph(was)}' ${was?.fg}/${was?.bg}→'${glyph(cell)}' ${cell.fg}/${cell.bg}`]
  }))
  check(`${critter.name}: no cell of the head or the wordmark changes glyph, ink or ground when the app takes the screen (${moved.length} do)`, moved.length === 0, `${moved.slice(0, 5).join(' · ')}; splashCoreFor in src/screen/widgets/useSplashCoreAccent.ts must hand the Boot screens the splash core's own 16 tier when colorDepth() is 16`)
}

section('§8 the reader of the core\'s rows learns the sixteen basic inks and refuses every other parameter as before')
const { parseSplashRuns } = await import('../../src/screen/widgets/splashRuns.ts')
const inkRead = (sgr: string): string => {
  try {
    return parseSplashRuns(`\x1b[${sgr}mx`)[0]?.fg ?? 'no ink'
  } catch (error) {
    return `refused: ${(error as Error).message}`
  }
}
const basicInks = ['30', '31', '36', '37', '90', '91', '97'].map(inkRead).join(' ')
check(`ESC[30m, 31, 36, 37, 90, 91 and 97 are read as the renderer's own named colours (${basicInks})`, basicInks === 'ansi:black ansi:red ansi:cyan ansi:white ansi:blackBright ansi:redBright ansi:whiteBright', 'parseSplashRuns in src/screen/widgets/splashRuns.ts must hand 30 to 37 and 90 to 97 on as ansi:<name> and ansi:<name>Bright')
for (const sgr of ['40', '100', '38;5;9', '48;5;9', '39', '7', '29', '98']) {
  const got = inkRead(sgr)
  check(`ESC[${sgr}m is refused as it was`, got.startsWith(`refused: splashRuns: SGR parameter ${sgr.split(';')[0]} is outside the core's emitter vocabulary`), `it read ${got}; parseSplashRuns must throw on every parameter but 0, 1, 2, 4, 38;2, 48;2 and the sixteen basic inks`)
}

if (failures === 0) {
  rmSync(scratch, { recursive: true, force: true })
  console.log('\nprove-16-colour-paint-is-basic: all green')
  process.exit(0)
}
console.log(`\nprove-16-colour-paint-is-basic: ${failures} FAILURE(S) — captures kept under ${scratch}`)
process.exit(1)
