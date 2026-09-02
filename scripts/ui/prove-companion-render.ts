#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-companion-render.ts — the ARMED companion PAINTS.
//
//  The logic proof (prove-deck-companion.ts) covers the gate/signals/moods and
//  the voice proof (scripts/critters/prove-companion-voice.ts) the words —
//  but only a capture shows a wiring break between the gate and the pixels.
//  These are the render legs: the real binary, MERCURY_DECK_COMPANION=1 (the
//  scenarios override the global hermeticity pin), at BOTH widths.
//
//  The companion row is the creature and its NAME (the creature is the
//  session's, so the legs assert the name row from the live pool, never a
//  golden). No rarity layer may paint: no stars, no shiny glint, no
//  personality archetype anywhere on the surface.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`

type Grid = { grid: Array<Array<{ c: string }>> }
function capture(scenario: string, cols: number, rows: number): string | null {
  const res = spawnSync(
    BUN,
    [
      'run',
      join(ROOT, 'scripts/ui/render-tui.ts'),
      '--scenario', scenario,
      '--cols', String(cols),
      '--rows', String(rows),
      '--out', `/tmp/prove-companion-${scenario}.png`,
    ],
    { encoding: 'utf8', timeout: 180_000, cwd: ROOT },
  )
  if (res.status !== 0) {
    console.log(`  [FAIL] render-tui(${scenario}) exited ${res.status}: ${res.stderr?.slice(0, 300)}`)
    failures++
    return null
  }
  const g = JSON.parse(readFileSync(`/tmp/grid-${cols}.json`, 'utf8')) as Grid
  return g.grid.map(row => row.map(c => c.c).join('')).join('\n')
}

// The creature names of the live pool — the row names one of them.
const { ALL_CRITTERS } = await import('../../src/components/mercury-ui/sessionAccent.ts')
const NAMES = ALL_CRITTERS.map(c => c.name)
const namesRow = (all: string): boolean => NAMES.some(n => all.includes(n))
// The retired rarity layer, by its visible marks.
const ARCHETYPE = /(a bug-sniffer|a steady hand|an agent of chaos|an old soul|a sharp tongue) who /
const STARS = /★/

console.log('============================================================')
console.log(' armed companion paints — render legs')
console.log('============================================================')

console.log('\n── cockpit (120 cols): the berth carries the creature ───────')
{
  const all = capture('companion-cockpit', 120, 40)
  if (all) {
    // The mascot stands alone in the berth: the
    // hero companion bubble is silent at idle — no "● <name>" tag beside it.
    check('the creature name does NOT paint beside the berth (the mascot stands alone)', !namesRow(all))
    check('no rarity stars paint', !STARS.test(all))
    check('no personality archetype paints', !ARCHETYPE.test(all))
  }
}

console.log('\n── deck strip (80 cols): the COMPANION DOCK carries it ─────')
{
  const all = capture('companion-deck', 80, 40)
  if (all) {
    check('the creature name paints in the dock', namesRow(all))
    check('no rarity stars paint', !STARS.test(all))
    check('no personality archetype paints', !ARCHETYPE.test(all))
    // STRUCTURE, never the model string: the band's model token follows the
    // live account. The ops row is the stable anchor.
    check('ops row paints under it (daemon · fleet · trace)', all.includes('daemon') && all.includes('fleet'))
  }
}

console.log()
if (failures > 0) {
  console.log(`❌ COMPANION-RENDER PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ COMPANION-RENDER PROOF PASS')
