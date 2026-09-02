#!/usr/bin/env bun

import {
  findRows,
  firstOutputTs,
  grabScreens,
  runArtifactArena,
} from '../streaming/artifactArena.ts'

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

const SETTLE_HOLD = 1600
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

const [before, after, late] = grabScreens(run, 120, 40, [
  streamEnd + 800,
  settleAt + 600,
  settleAt + 1400,
])

const sentinels = Array.from({ length: sIdx }, (_, i) => `⟦S${i}⟧`)
const rowOf = (rows: string[], needle: string): number => findRows(rows, needle)[0] ?? -1

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
  check('no late reflow (settle+600 == settle+1400)', lateMoved.length === 0, lateMoved.join(' '))
}

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
