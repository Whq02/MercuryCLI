#!/usr/bin/env bun

import {
  findRows,
  grabScreens,
  runArtifactArena,
  sendStamp,
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

const END = '⟦END⟧'
deltas[deltas.length - 1] += END
const S = vshotBudgetScale()
const SETTLE_HOLD = Math.round(1600 * S)
const run = await runArtifactArena({
  turns: [{ kind: 'paced', deltas, gapMs: 40, settleDelayMs: SETTLE_HOLD }],
  sends: [
    { awaitText: 'Type a prompt', text: 'hello\r' },
    { awaitText: [END], awaitAbsent: 'ready · ', text: '' },
    { awaitText: [END, 'ready · '], text: '' },
  ],
  seconds: 16,
  probe: true,
  keep: true,
})
const emits = run.fixture.pacedEmits
check('fixture streamed fully', emits.length === deltas.length, `${emits.length}/${deltas.length}`)
const observed = run.sendLog.filter(record => Array.isArray(record.awaitText) && record.awaitText.includes(END))
check('the last delta paints before settle, then the ready state paints with that same text', observed.length === 2 && observed.every(record => record.screen !== undefined) && observed[0]!.sent < observed[1]!.sent)
const before = { rows: observed[0]?.screen ?? [] }
const after = { rows: observed[1]?.screen ?? [] }
const late = observed[1] === undefined ? { rows: [] } : grabScreens(run, 120, 40, [sendStamp(run, observed[1]) + 800 * S])[0]

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
  check('no late reflow after the observed ready frame', lateMoved.length === 0, lateMoved.join(' '))
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
