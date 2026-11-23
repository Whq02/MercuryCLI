#!/usr/bin/env bun
import { join } from 'node:path'
import {
  CRITTERS,
  SQUARE_DOCK_ART_LINES,
  cellColor,
  heroBlinkRows,
  sleepSlotCountFor,
  sleepZzzSlots,
  squareDockArtFor,
} from '../../src/screen/cockpit/critterData.js'
import { composeCritterFrame } from '../../src/screen/widgets/CritterArt.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§1 geometry — 6×11 docks, the slot held')
{
  check('SQUARE_DOCK_ART_LINES is the pairer\'s 3 rows (the slot never moves)', SQUARE_DOCK_ART_LINES === 3, `got ${SQUARE_DOCK_ART_LINES}; SQUARE_DOCK_ART_LINES in src/screen/cockpit/critterData.ts must stay 3, so keep every critter squareDock the height the pairer expects`)
  for (const def of CRITTERS) {
    const dock = def.squareDock
    check(`${def.name}: dock is 6 rows`, dock.length === 6, `got ${dock.length} rows; make squareDock of this critter in src/screen/cockpit/critterData.ts 6 rows`)
    check(`${def.name}: dock rows uniformly 11 wide`, dock.every(r => r.length === 11), `row widths ${[...new Set(dock.map(r => r.length))].join(',')}; pad every squareDock row of this critter in src/screen/cockpit/critterData.ts to 11 chars`)
    check(`${def.name}: the accessor hands the STABLE record array (cache-keyable)`, squareDockArtFor(def.name) === dock, 'squareDockArtFor in src/screen/cockpit/critterData.ts must return the critter squareDock array itself, not a copy')
  }
}

section('§2 the dock grids\' integrity — the one sprite every berth paints')
{
  const LEGEND = new Set(['.', 'M', 'm', 'D', 'C', 'L', '%', 'E', 'K'])
  for (const def of CRITTERS) {
    const art = def.squareDock
    const chars = new Set(art.join(''))
    check(`${def.name}: legend chars only`, [...chars].every(c => LEGEND.has(c)), `chars outside the legend: ${[...chars].filter(c => !LEGEND.has(c)).join('')}; replace them in the squareDock of this critter in src/screen/cockpit/critterData.ts`)
    check(`${def.name}: no control chars`, art.every(r => [...r].every(c => c.codePointAt(0)! >= 0x20)), 'remove control characters from the squareDock rows of this critter in src/screen/cockpit/critterData.ts')
    check(`${def.name}: every non-empty char maps in cellColor`, [...chars].filter(c => c !== '.').every(c => /^#[0-9a-f]{6}$/i.test(cellColor(def, c) ?? '')), 'cellColor in src/screen/cockpit/critterData.ts must map every non-empty dock char to a #rrggbb colour; add the missing palette entry for this critter')
    check(`${def.name}: has the cream-eye language`, chars.has('E') && chars.has('K'), 'the squareDock of this critter in src/screen/cockpit/critterData.ts needs both the E (cream eye) and K (pupil) cells')
    const nearWhites = new Set<string>()
    for (const c of chars) {
      const hex = cellColor(def, c)
      if (!hex) continue
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
      if (Math.min(r!, g!, b!) > 220) nearWhites.add(`${c}:${hex.toLowerCase()}`)
    }
    check(`${def.name}: near-white = deliberate cream only`, [...nearWhites].every(v => v.startsWith('E:#ede8dd')), `near-white cells ${[...nearWhites].join(',')}; only the E cream colour may be near-white, so darken the other palette entries in src/screen/cockpit/critterData.ts`)
    const blink = heroBlinkRows(art)
    check(`${def.name}: blink preserves geometry`, blink.length === art.length && blink.every((r, i) => r.length === art[i]!.length), 'heroBlinkRows in src/screen/cockpit/critterData.ts must return the same number of rows and widths as its input')
    check(`${def.name}: blink closes every pupil`, !blink.join('').includes('K'), 'heroBlinkRows in src/screen/cockpit/critterData.ts must replace every K pupil cell when it closes the eyes')
    const untouched = art.every((row, i) => {
      const isEyePair = row.includes('K') || (art[i ^ 1]?.includes('K') ?? false)
      return isEyePair || blink[i] === row
    })
    check(`${def.name}: a blink touches ONLY the eye row-pair`, untouched, 'heroBlinkRows in src/screen/cockpit/critterData.ts changed a row outside the eye row pair; limit it to the rows holding K and their pair')
    const eyeRow = art.findIndex(r => r.includes('K'))
    check(`${def.name}: the eyes DO close`, eyeRow >= 0 && blink[eyeRow] !== art[eyeRow] && !blink[eyeRow]!.includes('E'), `eye row ${eyeRow}; heroBlinkRows in src/screen/cockpit/critterData.ts must change the eye row and drop its E cells, and the dock needs a K row`)
  }
}

section('§3 sleep air — the dock keeps a glyph\'s air; lid-only sleep stays a lid')
{
  for (const def of CRITTERS) {
    const count = sleepSlotCountFor(def)
    const dockSlots = sleepZzzSlots(def.squareDock, count)
    check(`${def.name}: the dock keeps at least one glyph's air`, dockSlots.length >= 1, `slots [${dockSlots.join(',')}]; sleepZzzSlots and sleepSlotCountFor in src/screen/cockpit/critterData.ts must leave at least one free slot in the dock of this critter`)
    const lidAwake = composeCritterFrame(def, { square: true, pupil: '—', gazeKey: '', swayPhase: 0, sleepPhase: null })
    const asleep = composeCritterFrame(def, { square: true, pupil: '—', gazeKey: '', swayPhase: 0, sleepPhase: 2 })
    check(`${def.name}: the sleeping square carries no pupil`, asleep.art.every(r => !r.includes('K')), 'composeCritterFrame in src/screen/widgets/CritterArt.tsx must close the pupils of a sleeping square frame')
    check(
      `${def.name}: sleep writes ONLY the top pair (the body is the lidded awake body)`,
      asleep.art.slice(2).join('\n') === lidAwake.art.slice(2).join('\n'),
      'composeCritterFrame in src/screen/widgets/CritterArt.tsx changed rows below the top pair when asleep; sleep may only rewrite rows 0 and 1',
    )
    check(`${def.name}: the glyph cells sit in the top pair alone`, asleep.art.slice(0, 2).some(r => r.includes('z')) || count === 0, 'composeCritterFrame in src/screen/widgets/CritterArt.tsx must draw the sleep glyph cells in the top two rows only')
  }
}


if (failures > 0) {
  console.error(`\n❌ ${failures} SQUARE-BERTH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL SQUARE-BERTH PROOFS PASS')
