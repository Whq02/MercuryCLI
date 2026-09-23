#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CRITTERS,
  FLAT_ART_LINES,
  SQUARE_ART_LINES,
  cellColor,
  heroBlinkRows,
  sleepSlotCountFor,
  sleepZzzSlots,
  squareArtFor,
  squareDockArtFor,
} from '../../src/utils/cockpit/critterData.js'
import { composeCritterFrame } from '../../src/components/mercury-ui/CritterArt.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§1 geometry — 12×13 squares, 6×11 docks, the slot held')
{
  check('SQUARE_ART_LINES === FLAT_ART_LINES (the berth slot never moved)', SQUARE_ART_LINES === FLAT_ART_LINES, `${SQUARE_ART_LINES} vs ${FLAT_ART_LINES}`)
  for (const def of CRITTERS) {
    const sq = def.square
    const dock = def.squareDock
    check(`${def.name}: square is 12 rows`, sq.length === 12, String(sq.length))
    check(`${def.name}: square rows uniformly 13 wide`, sq.every(r => r.length === 13), [...new Set(sq.map(r => r.length))].join(','))
    check(`${def.name}: dock is 6 rows`, dock.length === 6, String(dock.length))
    check(`${def.name}: dock rows uniformly 11 wide`, dock.every(r => r.length === 11), [...new Set(dock.map(r => r.length))].join(','))
    check(`${def.name}: the accessors hand the STABLE record arrays (cache-keyable)`, squareArtFor(def.name) === sq && squareDockArtFor(def.name) === dock)
  }
}

section('§2 the dock grids\' integrity — the one sprite every berth paints')
{
  const LEGEND = new Set(['.', 'M', 'm', 'D', 'C', 'L', '%', 'E', 'K'])
  for (const def of CRITTERS) {
    const art = def.squareDock
    const chars = new Set(art.join(''))
    check(`${def.name}: legend chars only`, [...chars].every(c => LEGEND.has(c)), [...chars].filter(c => !LEGEND.has(c)).join(''))
    check(`${def.name}: no control chars`, art.every(r => [...r].every(c => c.codePointAt(0)! >= 0x20)))
    check(`${def.name}: every non-empty char maps in cellColor`, [...chars].filter(c => c !== '.').every(c => /^#[0-9a-f]{6}$/i.test(cellColor(def, c) ?? '')))
    check(`${def.name}: has the cream-eye language`, chars.has('E') && chars.has('K'))
    const nearWhites = new Set<string>()
    for (const c of chars) {
      const hex = cellColor(def, c)
      if (!hex) continue
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
      if (Math.min(r!, g!, b!) > 220) nearWhites.add(`${c}:${hex.toLowerCase()}`)
    }
    check(`${def.name}: near-white = deliberate cream only`, [...nearWhites].every(v => v.startsWith('E:#ede8dd')), [...nearWhites].join(','))
    const blink = heroBlinkRows(art)
    check(`${def.name}: blink preserves geometry`, blink.length === art.length && blink.every((r, i) => r.length === art[i]!.length))
    check(`${def.name}: blink closes every pupil`, !blink.join('').includes('K'))
    const untouched = art.every((row, i) => {
      const isEyePair = row.includes('K') || (art[i ^ 1]?.includes('K') ?? false)
      return isEyePair || blink[i] === row
    })
    check(`${def.name}: a blink touches ONLY the eye row-pair`, untouched)
    const eyeRow = art.findIndex(r => r.includes('K'))
    check(`${def.name}: the eyes DO close`, eyeRow >= 0 && blink[eyeRow] !== art[eyeRow] && !blink[eyeRow]!.includes('E'), `eye row ${eyeRow}`)
  }
}

section('§3 sleep air — the glyph ladder fits; lid-only sleep stays a lid')
{
  for (const def of CRITTERS) {
    const count = sleepSlotCountFor(def)
    const berthSlots = sleepZzzSlots(def.square, count)
    check(`${def.name}: the berth square keeps the FULL ladder's air (${count} slots)`, berthSlots.length === count, `slots [${berthSlots.join(',')}]`)
    const dockSlots = sleepZzzSlots(def.squareDock, count)
    check(`${def.name}: the dock keeps at least one glyph's air`, dockSlots.length >= 1, `slots [${dockSlots.join(',')}]`)
    const lidAwake = composeCritterFrame(def, { square: true, pupil: '—', gazeKey: '', swayPhase: 0, sleepPhase: null })
    const asleep = composeCritterFrame(def, { square: true, pupil: '—', gazeKey: '', swayPhase: 0, sleepPhase: 2 })
    check(`${def.name}: the sleeping square carries no pupil`, asleep.art.every(r => !r.includes('K')))
    check(
      `${def.name}: sleep writes ONLY the top pair (the body is the lidded awake body)`,
      asleep.art.slice(2).join('\n') === lidAwake.art.slice(2).join('\n'),
    )
    check(`${def.name}: the glyph cells sit in the top pair alone`, asleep.art.slice(0, 2).some(r => r.includes('z')) || count === 0)
  }
}

section('§4 the mounts (source locks)')
{
  const root = join(import.meta.dir, '../../src')
  const home = readFileSync(join(root, 'components/MercuryHome.tsx'), 'utf8')
  const berth = home.slice(home.indexOf('export function PinnedCritterBerth'), home.indexOf('export function MercuryHero'))
  check('the berth rebinds the 11×6 square-dock grid and renders square', berth.includes('square: squareDockArtFor(sa.key)') && berth.includes('<AnimatedCritterArt def={hover ? hoverDockDef : dockDef} square />'))
  check('the berth slot derives from SQUARE_DOCK_ART_LINES', berth.includes('height={SQUARE_DOCK_ART_LINES}'))
  const mini = readFileSync(join(root, 'components/mercury-ui/MiniCritter.tsx'), 'utf8')
  check('the mini row rebinds the 11×6 square-dock grid', mini.includes('square: squareDockArtFor('))
  const bare = mini.slice(mini.indexOf('function BareMiniArt'))
  check('the dock renders the square form through the shared art in both mounts', bare.includes('<AnimatedCritterArt def={miniDef} square />') && /if \(bare\)\s*\{\s*return <BareMiniArt/.test(mini) && mini.includes('<BareMiniArt miniDef={miniDef} />'))
  const band = readFileSync(join(root, 'components/CompactIdentityBand.tsx'), 'utf8')
  check('the compact band rebinds the dock grid and renders square in the dock-height slot', band.includes('square: squareDockArtFor(sa.key)') && band.includes('height={SQUARE_DOCK_ART_LINES}') && band.includes('<AnimatedCritterArt def={def} square />'))
  const anim = readFileSync(join(root, 'components/mercury-ui/AnimatedCritterArt.tsx'), 'utf8')
  check('the animator gazes over the square grid', anim.includes('usingSquare ? def.square'))
}

if (failures > 0) {
  console.error(`\n❌ ${failures} SQUARE-BERTH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL SQUARE-BERTH PROOFS PASS')
