#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-settle-slot.ts — COCKPIT S4: the settle-slot
//  law, proven on the SHIPPED artifact.
//
//  The law: stream→settled is a ROW-COORDINATE NO-OP. The in-flight
//  nameplate reserves the finalized clock's 9-cell width (CLOCK_SLOT,
//  ChatLine.tsx), so the `HH:MM:SS` digits fade into a slot that already
//  existed — no rewrap, no row shift, painted prose never moves. (The S1
//  baseline caught the violation: the clock's arrival widened line 1 by 9
//  cells and rewrapped the WHOLE settled paragraph, shifting every row.)
//
//  Method: one hermetic artifactArena run streaming sentinel-tagged prose;
//  pyte screens straddling the settle instant; assert (a) every sentinel
//  keeps its exact row, (b) the nameplate's `[` keeps its exact column while
//  the clock digits appear before it.
// ============================================================================

import {
  findRows,
  firstOutputTs,
  grabScreens,
  runArtifactArena,
} from '../streaming/artifactArena.ts'
import { vshotBudgetScale } from '../lib/captureDriver.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── settle-slot law (shipped artifact) ──')

const WORDS = 'liquid frame cadence settle anchor lattice glyph honest state viewport'.split(' ')
const deltas: string[] = []
let sIdx = 0
for (let i = 0; i < 110; i++) {
  if (i > 0 && i % 15 === 0) {
    deltas.push(`⟦S${sIdx++}⟧`)
    continue
  }
  const w = WORDS[(i * 7 + 3) % WORDS.length]!
  deltas.push(i % 40 === 39 ? `${w}.\n` : `${w} `)
}

// settleDelayMs holds the fixture's terminal frames after the last delta:
// the app sits FULLY PAINTED but unsettled. The law binds the SETTLE SWAP —
// content still arriving is ordinary stream growth (the bottom-pinned view
// legitimately translates as the last line wraps), so the BEFORE grab must
// land after the final paint, not mid-stream.
// The hold and the grab offsets are RUNNER-SPEED premises ("+800 after the
// last delta everything is painted"): the hosted 2-core runner paints
// behind the fixture's emits by the same stretch every capture rides, so
// both scale with the one multiplier (authored at 1 locally).
const S = vshotBudgetScale()
const SETTLE_HOLD = Math.round(1600 * S)
const run = await runArtifactArena({
  turns: [{ kind: 'paced', deltas, gapMs: 40, settleDelayMs: SETTLE_HOLD }],
  sends: ['4500:hello', '5300:\\r'],
  seconds: 16,
  probe: true,
  keep: true,
})
const base = firstOutputTs(run)
const emits = run.fixture.pacedEmits
check('fixture streamed fully', emits.length === deltas.length, `${emits.length}/${deltas.length}`)
const streamEnd = (emits.at(-1)?.at ?? 0) - base
const settleAt = streamEnd + SETTLE_HOLD

// Straddle the settle: +800 after the last delta everything is painted and
// the turn is still streaming (the hold keeps message_stop away); +600 past
// the hold is comfortably settled; +1400 guards against late reflows.
const [before, after, late] = grabScreens(run, 120, 40, [
  streamEnd + 800 * S,
  settleAt + 600 * S,
  settleAt + 1400 * S,
])

const sentinels = Array.from({ length: sIdx }, (_, i) => `⟦S${i}⟧`)
const rowOf = (rows: string[], needle: string): number => findRows(rows, needle)[0] ?? -1

// (a) every sentinel keeps its exact row across the settle swap
{
  const moved: string[] = []
  for (const s of sentinels) {
    const b = rowOf(before!.rows, s)
    const a = rowOf(after!.rows, s)
    if (b === -1 || a === -1 || b !== a) moved.push(`${s}:${b}→${a}`)
  }
  check(
    `all ${sentinels.length} sentinels hold their rows across settle`,
    moved.length === 0,
    moved.join(' '),
  )
  const lateMoved: string[] = []
  for (const s of sentinels) {
    const a = rowOf(after!.rows, s)
    const l = rowOf(late!.rows, s)
    if (a !== l) lateMoved.push(`${s}:${a}→${l}`)
  }
  check('no late reflow (settle+600 == settle+1400, in the stretched clock)', lateMoved.length === 0, lateMoved.join(' '))
}

// (b) the nameplate column is stable: `[Mercury]` sits at the SAME column,
// and the clock digits appear IN the reserved slot before it.
{
  const bRow = before!.rows.find(r => r.includes('[Mercury]'))
  const aRow = after!.rows.find(r => r.includes('[Mercury]'))
  check('nameplate present on both sides of settle', !!bRow && !!aRow)
  if (bRow && aRow) {
    const bCol = bRow.indexOf('[Mercury]')
    const aCol = aRow.indexOf('[Mercury]')
    check('the `[Mercury]` column is IDENTICAL across settle', bCol === aCol, `${bCol} vs ${aCol}`)
    const slotBefore = bRow.slice(Math.max(0, bCol - 9), bCol)
    const slotAfter = aRow.slice(Math.max(0, aCol - 9), aCol)
    check('before settle the clock slot is blank', slotBefore.trim() === '', JSON.stringify(slotBefore))
    check(
      'after settle the slot carries the HH:MM:SS digits',
      /\d{2}:\d{2}:\d{2} $/.test(slotAfter),
      JSON.stringify(slotAfter),
    )
  }
}

run.cleanup()
console.log(failures === 0 ? '✅ settle-slot GREEN' : `❌ settle-slot RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
