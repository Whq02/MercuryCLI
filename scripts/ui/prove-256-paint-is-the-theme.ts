#!/usr/bin/env bun
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixPtyDriverOrSkip } from '../lib/captureDriver.ts'
import { artRows, colourDepthJourney, DIST, inkOf, isBlock, isGreyInk, isHexInk, JOURNEY_MARKS, type Grid } from './colourDepthJourney.ts'

const driver = posixPtyDriverOrSkip('256-paint-is-the-theme')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'paint-256-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'proof-home')

const { rgbToXterm256, xterm256ToRgb } = await import('../../src/screen/renderer/cell-grid.ts')
const { FAINT, SECOND, groundFamilyFor } = await import('../../src/screen/theme/mercuryPalette.ts')
const { CRITTERS } = await import('../../src/screen/cockpit/critterData.ts')

const MAPPER = 'rgbToXterm256 in src/screen/renderer/cell-grid.ts must give the nearest of 16..255 by Oklab, and colorize in src/screen/renderer/colorize.ts must paint a #rrggbb or rgb() colour through it at 256 colours'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail.slice(0, 600)}`}`)
}
function section(title: string): void {
  console.log('\n' + title)
}

const hexOf = (index: number): string => (xterm256ToRgb(index) ?? [0, 0, 0]).map(v => v.toString(16).padStart(2, '0')).join('')
const nearest = (ink: string): string => hexOf(rgbToXterm256(parseInt(ink.slice(0, 2), 16), parseInt(ink.slice(2, 4), 16), parseInt(ink.slice(4, 6), 16)))
const LIBRARY_TABLE = new Map([108, 151, 17, 23].map(index => [hexOf(index), index]))
const SURFACES = new Set(Object.values(groundFamilyFor('dark')).map(inkOf))
const CANVAS = inkOf(groundFamilyFor('dark').NIGHT)
const PLANES = ['fg', 'bg'] as const
const tally = (inks: Iterable<string>): string => {
  const counts = new Map<string, number>()
  for (const ink of inks) counts.set(ink, (counts.get(ink) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ink, n]) => `${ink}×${n}`).join(' ')
}
const inksUnder = (full: Grid, low: Grid, theme: string): string[] => full.flatMap((row, y) => row.flatMap((cell, x) => (cell.fg === theme && (cell.c || ' ') !== ' ' ? [low[y]?.[x]?.fg ?? 'absent'] : [])))

console.log('prove-256-paint-is-the-theme — at 256 colours the screen holds the theme\'s own colours, each the nearest of 16..255')

for (const critter of CRITTERS) {
  const family = critter.name
  const full = await colourDepthJourney(driver, scratch, `${family}-truecolor`, { TERM: 'xterm-256color', COLORTERM: 'truecolor', MERCURY_CRITTER: family })
  const low = await colourDepthJourney(driver, scratch, `${family}-256`, { TERM: 'xterm-256color', MERCURY_CRITTER: family })

  section(`${family} §1 the journey ran at 24 bits and at 256: the first-run theme step, the Boot face, the first session screen`)
  for (const arm of [full, low]) {
    check(`${arm.name}: the capture ended cleanly with its three marks`, arm.status === 0 && JOURNEY_MARKS.every(mark => arm.marks.has(mark)), `the capture exited ${arm.status} with marks ${[...arm.marks.keys()].join(',')}; build dist/mercury.mjs with bun run build.ts and read ${arm.name}.log under ${scratch}: ${arm.log.slice(-300)}`)
  }
  const frames = JOURNEY_MARKS.flatMap(mark => {
    const f = full.marks.get(mark)
    const l = low.marks.get(mark)
    return f && l ? [{ mark, f, l }] : []
  })
  for (const { mark, f, l } of frames) {
    const differ = f.flatMap((row, y) => row.filter((cell, x) => (cell.c || ' ') !== (l[y]?.[x]?.c || ' '))).length
    check(`${mark}: the glyphs are the same cell for cell at both depths`, differ === 0, `${differ} cells differ; the colour depth must not change a glyph: compare ${full.name}.json and ${low.name}.json under ${scratch}`)
  }

  section(`${family} §2 the muted ink and the secondary ink are greys`)
  for (const [word, theme] of [['muted', inkOf(FAINT)], ['secondary', inkOf(SECOND)]] as const) {
    let seen = 0
    for (const { mark, f, l } of frames) {
      const inks = inksUnder(f, l, theme)
      if (inks.length === 0) continue
      seen += inks.length
      const coloured = inks.filter(ink => !isGreyInk(ink))
      check(`${mark}: every cell in the ${word} ink #${theme} is a grey at 256 (${inks.length} cells)`, coloured.length === 0, `${coloured.length} cells are not grey (${tally(coloured)}); ${MAPPER}`)
    }
    check(`the ${word} ink is on the journey's screens (${seen} cells)`, seen >= 40, `only ${seen} cells carry #${theme} at 24 bits; the journey in scripts/ui/colourDepthJourney.ts no longer reaches a screen that paints it`)
  }

  section(`${family} §3 the wordmark keeps its ramp and the critter its colour`)
  let deepSeen = 0
  for (const { mark, f, l } of frames.filter(frame => frame.mark !== 'theme')) {
    const art = artRows(f)
    const top = art.wordmark[0]
    const ramp = new Set(top === undefined ? [] : l[top]!.filter(isBlock).map(cell => cell.fg))
    check(`${mark}: the wordmark's row holds three inks or more (${ramp.size})`, ramp.size >= 3, `row ${top} holds ${[...ramp].join(' ')}; ${MAPPER}`)
    const planes = art.critter.flatMap(y => f[y]!.flatMap((cell, x) => (isBlock(cell) ? PLANES.flatMap(plane => (isHexInk(cell[plane]) ? [{ theme: cell[plane], got: l[y]?.[x]?.[plane] ?? 'absent' }] : [])) : [])))
    const inks = new Set(planes.map(p => p.got))
    check(`${mark}: the critter holds two inks or more (${inks.size})`, inks.size >= 2, `the critter's rows ${art.critter.join(',')} hold ${tally(planes.map(p => p.got))}; ${MAPPER}`)
    const own = planes.filter(p => p.theme === inkOf(critter.hue) || p.theme === inkOf(critter.hueDeep))
    deepSeen += own.filter(p => p.theme === inkOf(critter.hueDeep)).length
    const greyed = own.filter(p => !isHexInk(p.got) || isGreyInk(p.got))
    check(`${mark}: the critter's own hue ${critter.hue} and its deep ${critter.hueDeep} are colours, not greys (${own.length} planes)`, own.some(p => p.theme === inkOf(critter.hue)) && greyed.length === 0, `${greyed.length} planes turned grey (${tally(greyed.map(p => `${p.theme}→${p.got}`))}); ${MAPPER}`)
  }
  check(`the critter's deep ink is on the journey's screens (${deepSeen} planes)`, deepSeen > 0, `no critter cell carries ${critter.hueDeep} at 24 bits on the Boot face or the session screen; the journey in scripts/ui/colourDepthJourney.ts no longer shows it`)

  section(`${family} §4 the Boot face and the first session screen: one mapper, grey surfaces, and none of the colour library's own picks`)
  for (const { mark, f, l } of frames.filter(frame => frame.mark !== 'theme')) {
    const wrong: string[] = []
    const tinted: string[] = []
    const library: string[] = []
    let coloured = 0
    let surfaces = 0
    f.forEach((row, y) => row.forEach((cell, x) => {
      for (const plane of PLANES) {
        const want = cell[plane]
        const got = l[y]?.[x]?.[plane] ?? 'absent'
        const index = LIBRARY_TABLE.get(got)
        if (index !== undefined && (plane === 'bg' || cell.rev || (cell.c || ' ') !== ' ')) library.push(`${y}:${x} ${plane} ${index}`)
        if (!isHexInk(want)) {
          if (want !== got) wrong.push(`${y}:${x} ${plane} ${want}→${got}`)
          continue
        }
        coloured++
        if (plane === 'bg' && got === 'default' && want === CANVAS) continue
        if (got !== nearest(want)) wrong.push(`${y}:${x} ${plane} ${want}→${got}, nearest ${nearest(want)}`)
        if (!SURFACES.has(want)) continue
        surfaces++
        if (!isGreyInk(got)) tinted.push(`${want}→${got}`)
      }
    }))
    check(`${mark}: every coloured plane is its 24-bit ink through rgbToXterm256 (${coloured} planes)`, coloured > 50 && wrong.length === 0, `${wrong.length} planes differ: ${wrong.slice(0, 5).join(' · ')}; ${MAPPER}`)
    check(`${mark}: every painted surface of the theme is a grey (${surfaces} planes)`, surfaces > 50 && tinted.length === 0, `${tinted.length} planes carry a tint (${tally(tinted)}); ${MAPPER}`)
    check(`${mark}: no ink that shows is 108, 151, 17 or 23`, library.length === 0, `${library.length} planes: ${library.slice(0, 6).join(' · ')}; a grey or a surface of the theme must not take the colour library's green, navy or teal: ${MAPPER}`)
  }
}

if (failures === 0) {
  rmSync(scratch, { recursive: true, force: true })
  console.log('\nprove-256-paint-is-the-theme: all green')
  process.exit(0)
}
console.log(`\nprove-256-paint-is-the-theme: ${failures} FAILURE(S) — captures kept under ${scratch}`)
process.exit(1)
