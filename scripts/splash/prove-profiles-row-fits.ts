#!/usr/bin/env bun
import { assembleCardRows, createSplashCore, withProfilesRow } from '../../assets/splash/splash-core.mjs'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { bootSplashCompositionOf } = await import('../../src/screen/boot-face/splash/face.tsx')

const core = createSplashCore({ nocolor: true })
const FIX = 'change withProfilesRow in assets/splash/splash-core.mjs, or the answer its callers give it (bootSplashCompositionOf in src/screen/boot-face/splash/face.tsx, shownCardRows in assets/splash/mercury-splash.mjs)'
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${[detail, FIX].filter(Boolean).join('; ')}`}`)
}

type Row = ReturnType<typeof assembleCardRows>[number]
type Painted = { lines: string[]; boxed: boolean }
const strip = (width: number): string[] => core.composeStrip({ model: 'Opus 5.5', dir: 'proj' }, width)
const bare = (list: Row[]): Row[] => list.map(row => ({ ...row, ctx: '' }))
const full = (cols: number) => (rows: number, list: Row[]): Painted => {
  const face = core.composeLockup(cols, rows, { cardRows: bare(list), cardSel: 0, hintSegments: [{ key: '↵', label: '', tone: 'ivory' }], tinyHint: '↵', stripLines: strip })
  return { lines: face.lines, boxed: face.cardShown }
}
const compact = (cols: number) => (rows: number, list: Row[]): Painted => {
  const face = core.composeCompactFace(cols, rows, { cardRows: bare(list), cardSel: 0, hintSegments: [{ key: '>_', label: '', tone: 'faint' }, { key: '↵', label: '', tone: 'ivory' }, { key: '↑↓', label: '', tone: 'faint' }], keyMap: '⇧→ concourse', stripLines: strip, pointer: '❯' })
  return { lines: face.lines, boxed: face.framed }
}
const KEYS = '⇧→ concourse'
const product = (cols: number, isCompact: boolean) => (rows: number, list: Row[]): Painted => {
  const face = bootSplashCompositionOf({ isCompact, composedRows: list, selectedIndex: 0, core, columns: cols, rows, modelDefaultDoor: false, stripHint: KEYS, wordGlow: null, rowGlow: null, bottomRowWithNotice: () => null, updateLine: null, chips: { model: 'Opus 5.5', dir: 'proj' }, plainWhy: null, keyMapHint: KEYS })
  return { lines: face.placed, boxed: face.boxed }
}
const worlds = [
  { name: 'a home with history (five rows)', rows: assembleCardRows({ cwdBase: 'proj', continueTarget: { base: 'proj', ageMs: 60_000, cross: false }, menuAvailable: true, concourse: { ctx: 'the live board' } }) },
  { name: 'a fresh home (four rows)', rows: assembleCardRows({ cwdBase: 'proj', continueTarget: null, menuAvailable: true, concourse: { ctx: 'the live board' } }) },
]
const layouts: Array<{ name: string; paint: (rows: number, list: Row[]) => Painted; from: number; to: number; pins?: Array<{ first: number; gaveWay: number[] }> }> = [
  { name: 'the launcher\'s full layout at 120 columns', paint: full(120), from: 8, to: 64 },
  { name: 'the launcher\'s compact face at 80 columns', paint: compact(80), from: 4, to: 40 },
  { name: 'the launcher\'s compact face at 40 columns', paint: compact(40), from: 4, to: 40 },
  { name: 'the product\'s full layout at 120 columns, from its first height', paint: product(120, false), from: 26, to: 64, pins: [{ first: 26, gaveWay: [36] }, { first: 26, gaveWay: [35] }] },
  { name: 'the product\'s compact face at 80 columns', paint: product(80, true), from: 4, to: 40, pins: [{ first: 12, gaveWay: [16] }, { first: 11, gaveWay: [15] }] },
  { name: 'the product\'s compact face at 40 columns', paint: product(40, true), from: 4, to: 40, pins: [{ first: 12, gaveWay: [] }, { first: 11, gaveWay: [] }] },
]
const ink = (lines: string[]): number => lines.filter(line => line.trim() !== '').length
const caretOn = (lines: string[], labels: string[]): string | undefined => labels.find(label => lines.some(line => line.includes('❯') && line.includes(label)))

console.log('the Profiles row on the Boot face: it shows wherever the card boxes one more row, and nothing 1.1.0 painted in rows or caret is lost')
for (const [w, world] of worlds.entries()) {
  const labels = world.rows.map(row => row.label)
  for (const layout of layouts) {
    const shows: number[] = []
    const lost: string[] = []
    const moved: string[] = []
    const gaveWay: number[] = []
    for (let rows = layout.from; rows <= layout.to; rows++) {
      const before = layout.paint(rows, world.rows)
      const shown = withProfilesRow(world.rows, list => layout.paint(rows, list).boxed)
      const now = layout.paint(rows, shown)
      const has = shown.length > world.rows.length
      if (has) shows.push(rows)
      for (const label of labels) if (before.lines.some(line => line.includes(label)) && !now.lines.some(line => line.includes(label))) lost.push(`${rows}: ${label}`)
      if (caretOn(before.lines, labels) !== caretOn(now.lines, labels)) lost.push(`${rows}: the caret`)
      if (!has && before.lines.join('\n') !== now.lines.join('\n')) moved.push(String(rows))
      if (has && ink(now.lines) !== ink(before.lines) + 1) gaveWay.push(rows)
    }
    const first = shows[0]
    const where = `${layout.name}, ${world.name}`
    check(`${where}: the row shows at some height and at every height above its first (${first ?? 'none'} to ${layout.to})`, first !== undefined && shows.length === layout.to - first + 1, `it shows at ${shows.join(', ')}`)
    check(`${where}: no row and no caret that the face without it paints is lost at any height`, lost.length === 0, lost.slice(0, 6).join(' | '))
    check(`${where}: where the row is absent the face is cell for cell the face without it`, moved.length === 0, `it differs at ${moved.join(', ')} rows`)
    console.log(`         with the row, the strip, the big logo or the banner gives way one row earlier at: ${gaveWay.length === 0 ? 'no height' : gaveWay.join(', ')}`)
    const pin = layout.pins?.[w]
    if (pin !== undefined) check(`${where}: the row first shows at ${pin.first} rows and the big logo or the banner gives way at ${pin.gaveWay.join(', ') || 'no height'}`, first === pin.first && gaveWay.join(' ') === pin.gaveWay.join(' '), `it first shows at ${first ?? 'no height'} and a decoration gives way at ${gaveWay.join(', ') || 'no height'}`)
  }
}

const history = worlds[0]!.rows
const at = (rows: number): Row[] => withProfilesRow(history, list => full(100)(rows, list).boxed)
check('the floor of the five-row card stands: at 19 rows the card shows its five rows and no Profiles row', full(100)(19, history).boxed && at(19).length === 5)
check('…and at 20 rows it shows six, Profiles last, under Boot Menu', at(20).map(row => row.key).join(' ') === 'new continue logins concourse menu profiles', at(20).map(row => row.key).join(' '))
const fresh = worlds[1]!.rows
check('40 by 10 is as it was: the fresh home\'s four rows in their box and no Profiles row, with history or without', compact(40)(10, fresh).boxed && withProfilesRow(fresh, list => compact(40)(10, list).boxed).length === 4 && withProfilesRow(history, list => compact(40)(10, list).boxed).length === 5)
check('a face with no Boot Menu row gains no Profiles row', withProfilesRow(assembleCardRows({ cwdBase: 'proj', continueTarget: null, menuAvailable: false, concourse: null }), () => true).every(row => row.key !== 'profiles'))

console.log(failures === 0 ? '\n✅ the Profiles row fits GREEN' : `\n❌ the Profiles row fits RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
