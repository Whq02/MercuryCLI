#!/usr/bin/env bun
// ============================================================================
//  prove-square-berths — THE SQUARE CRITTERS at the small berths
//  (chat-feel item 5): geometry, the hero berth's byte-identity, sleep air,
//  and the mounts' wiring.
//
//    §1 GEOMETRY — every square grid 12×13 uniform, every dock grid 6×11
//       uniform; SQUARE_ART_LINES === FLAT_ART_LINES, so the berth tier
//       swap moved pixels, never rows (the slot's stability contract).
//    §2 THE HERO BERTH IS BYTE-IDENTICAL — the square flag can never touch
//       the hero path (hero wins when both are set), and the hero rest
//       frame is exactly the authored heroArt content-sliced. POISON: the
//       square work leaking into the 120x40 berth.
//    §3 SLEEP AIR — the berth squares keep an EMPTY top pair: the full
//       glyph ladder fits (3 slots, the clam's 4); the docks keep at least
//       one glyph's air. Asleep (lid signal) a square frame carries no
//       pupil and writes glyphs only into the top pair; the body below is
//       byte-identical to the lidded awake frame (lid-only sleep — the
//       landed honest degradation, no authored pose).
//    §4 THE MOUNTS (source locks) — the berth renders square on the
//       sub-hero tier in the derived slot; the dock rebinds the 11×6 grid
//       and renders square; the animator's gaze covers the square grids.
//
//  Before/after look-captures at 120x40 + 100x30 (and the 80x24 dock) are
//  Look captures run at the pool — this is the mechanical half.
//  Run:  ~/.bun/bin/bun run scripts/critters/prove-square-berths.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CRITTERS,
  FLAT_ART_LINES,
  SQUARE_ART_LINES,
  flowDepthFor,
  heroContentBounds,
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

section('§2 the hero berth is byte-identical — square can never touch it')
{
  for (const def of CRITTERS) {
    if (!def.heroArt?.length) continue
    const hero = composeCritterFrame(def, { hero: true, pupil: '●', gazeKey: '', swayPhase: 0, sleepPhase: null })
    const both = composeCritterFrame(def, { hero: true, square: true, pupil: '●', gazeKey: '', swayPhase: 0, sleepPhase: null })
    check(`${def.name}: hero wins over a stray square flag (byte-equal frames)`, hero.art.join('\n') === both.art.join('\n'))
    // The authored-identity leg holds only for a still hero: a flowing one
    // legitimately sways at every phase (deeper lines take earlier phases,
    // and no phase zeroes them all) — its byte-identity is the hero-vs-both
    // equality above plus the untouched hero code path.
    if (flowDepthFor(def, 'hero') === 0) {
      const [s, e] = heroContentBounds(def.heroArt)
      const sliced = def.heroArt.map(r => r.slice(s, e)).join('\n')
      check(`${def.name}: the still hero's rest frame IS the authored heroArt, content-sliced`, hero.art.join('\n') === sliced)
    }
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
    // Asleep: the lid pupil signal + a sleep phase — no pupil anywhere,
    // glyphs only in the top pair, the body below byte-identical to the
    // lidded awake frame (no authored pose — the honest degradation).
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
  check('the berth renders square on the sub-hero tier', home.includes('square={!heroFits}'))
  check('the berth slot derives from SQUARE_ART_LINES', /heroFits \? HERO_ART_LINES : SQUARE_ART_LINES/.test(home))
  const mini = readFileSync(join(root, 'components/mercury-ui/MiniCritter.tsx'), 'utf8')
  check('the dock rebinds the 11×6 square-dock grid', mini.includes('square: squareDockArtFor('))
  check('the dock renders the square form', (mini.match(/<AnimatedCritterArt def=\{miniDef\} square \/>/g) ?? []).length === 2)
  const anim = readFileSync(join(root, 'components/mercury-ui/AnimatedCritterArt.tsx'), 'utf8')
  check('the animator gazes over the square grid', anim.includes('usingSquare ? def.square'))
}

if (failures > 0) {
  console.error(`\n❌ ${failures} SQUARE-BERTH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL SQUARE-BERTH PROOFS PASS')
