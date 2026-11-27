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
const { FAINT, IVORY, SECOND, groundFamilyFor } = await import('../../src/screen/theme/mercuryPalette.ts')
const { CRITTERS, cellColor } = await import('../../src/screen/cockpit/critterData.ts')

const MAPPER = 'rgbToXterm256 in src/screen/renderer/cell-grid.ts must give the nearest of 16..255 by Oklab with its chroma term weighted, and colorize in src/screen/renderer/colorize.ts must paint a #rrggbb or rgb() colour through it at 256 colours'
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
const NEUTRALS = new Set([...SURFACES, inkOf(FAINT), inkOf(SECOND), inkOf(IVORY)])
const CANVAS = inkOf(groundFamilyFor('dark').NIGHT)
const PLANES = ['fg', 'bg'] as const
const SHADES = ['M', 'D', 'C', 'm', 'K', 'L', '%']
const GREY_SHADES: Record<string, string[]> = { crab: [], octopus: ['K'], jellyfish: ['K'], clam: ['K'] }
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

  section(`${family} §3 the wordmark keeps its ramp and the critter its shading`)
  const greyShades = GREY_SHADES[family] ?? []
  const shadeInks = SHADES.flatMap(letter => {
    const color = cellColor(critter, letter)
    return color === undefined ? [] : [{ letter, ink: inkOf(color) }]
  })
  const paints = (letter: string, got: string): boolean => (greyShades.includes(letter) ? isGreyInk(got) : isHexInk(got) && !isGreyInk(got))
  const lost = shadeInks.filter(shade => !paints(shade.letter, nearest(shade.ink)))
  check(`of the critter's seven shades ${greyShades.length === 0 ? 'none is a grey' : `the darkest (${greyShades.join()}, the hue 72% to black) alone is a grey by the nearest`}`, shadeInks.length === SHADES.length && lost.length === 0, `${shadeInks.map(shade => `${shade.letter} #${shade.ink}→${nearest(shade.ink)}`).join(' ')}; ${MAPPER}`)
  let deepSeen = 0
  for (const { mark, f, l } of frames.filter(frame => frame.mark !== 'theme')) {
    const art = artRows(f)
    const top = art.wordmark[0]
    const ramp = new Set(top === undefined ? [] : l[top]!.filter(isBlock).map(cell => cell.fg))
    check(`${mark}: the wordmark's row holds three inks or more (${ramp.size})`, ramp.size >= 3, `row ${top} holds ${[...ramp].join(' ')}; ${MAPPER}`)
    const planes = art.critter.flatMap(y => f[y]!.flatMap((cell, x) => (isBlock(cell) ? PLANES.flatMap(plane => (isHexInk(cell[plane]) ? [{ theme: cell[plane], got: l[y]?.[x]?.[plane] ?? 'absent' }] : [])) : [])))
    const inks = new Set(planes.map(p => p.got))
    check(`${mark}: the critter holds two inks or more (${inks.size})`, inks.size >= 2, `the critter's rows ${art.critter.join(',')} hold ${tally(planes.map(p => p.got))}; ${MAPPER}`)
    const shaded = planes.flatMap(p => shadeInks.filter(shade => shade.ink === p.theme).slice(0, 1).map(shade => ({ ...p, letter: shade.letter })))
    deepSeen += shaded.filter(p => p.theme === inkOf(critter.hueDeep)).length
    const greyed = shaded.filter(p => !paints(p.letter, p.got))
    check(`${mark}: every cell of the critter in one of its shades keeps that shade's colour (${shaded.length} planes)`, shaded.some(p => p.theme === inkOf(critter.hue)) && greyed.length === 0, `${greyed.length} planes are wrong (${tally(greyed.map(p => `${p.letter} #${p.theme}→${p.got}`))}); ${MAPPER}`)
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
        if (index !== undefined && NEUTRALS.has(want)) library.push(`${y}:${x} ${plane} ${want}→${index}`)
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
    check(`${mark}: no grey and no surface of the theme is painted 108, 151, 17 or 23`, library.length === 0, `${library.length} planes: ${library.slice(0, 6).join(' · ')}; those are the colour library's green, navy and teal for the theme's greys: ${MAPPER}`)
  }
}

if (failures === 0) {
  rmSync(scratch, { recursive: true, force: true })
  console.log('\nprove-256-paint-is-the-theme: all green')
  process.exit(0)
}
console.log(`\nprove-256-paint-is-the-theme: ${failures} FAILURE(S) — captures kept under ${scratch}`)
process.exit(1)
