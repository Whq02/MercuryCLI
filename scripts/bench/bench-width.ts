#!/usr/bin/env bun
// ============================================================================
//  scripts/bench/bench-width.ts — perf-regression guard for the cell-width
//  primitives every kit grid calls on a hot render path (made
//  glyphs.ts delegate to ink/stringWidth + utils/truncate). A grid re-measures
//  dozens of cells per render at up to 20fps (the ultrathink shimmer), so a
//  width primitive that goes O(n²) or 10×-slower silently jank-degrades the TUI.
//  This asserts an ops/sec FLOOR (order-of-magnitude, not noise) so a future
//  regression goes RED. Pure-logic, no API, deterministic.
//  Run:  ~/.bun/bin/bun run scripts/bench/bench-width.ts
// ============================================================================
import { stringWidth } from '../../src/ink/stringWidth.js'
import { truncateToWidth } from '../../src/utils/truncate.js'

let failures = 0
const SLACK = Math.max(1, Number(process.env.MERCURY_BENCH_SLACK) || 1)

// A realistic mix: ASCII (the common path), CJK, accented, an emoji, a glyph row.
const SAMPLES = [
  'realm  orchard-src  ⌥main · clean',
  'MCP policy gate          MERCURY_MCP_MAX_RISK=low|medium',
  '● Capability manifest   always-on (fork) · ToolSearch',
  'café 日本語 ▖▟▆▙▗ ●○◐◆◉ résumé',
  'a'.repeat(120),
]

function bench(label: string, fn: () => void, iters: number, floorOpsSec: number): void {
  // warm up (JIT) then time.
  for (let i = 0; i < 1000; i++) fn()
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const opsSec = Math.round((iters / ms) * 1000)
  const floor = Math.round(floorOpsSec / SLACK)
  const ok = opsSec >= floor
  if (!ok) failures++
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${label}: ${opsSec.toLocaleString()} ops/sec (floor ${floor.toLocaleString()})`,
  )
}

console.log('============================================================')
console.log(' Cell-width primitives — perf floor (HB-0005 hot path)')
console.log('============================================================')

// Floors are deliberately generous (≈10× below a typical run) so they flag an
// order-of-magnitude regression, never machine noise.
bench(
  'stringWidth over a mixed grid row',
  () => { for (const s of SAMPLES) stringWidth(s) },
  20_000,
  50_000,
)
bench(
  'truncateToWidth (grapheme-safe) over the mix',
  () => { for (const s of SAMPLES) truncateToWidth(s, 24) },
  20_000,
  4_000,
)
// Correctness backstop alongside the perf floor — a regression that makes it
// "fast" by breaking measurement should still go red.
{
  const checks: Array<[string, number, number]> = [
    ['abc', stringWidth('abc'), 3],
    ['café', stringWidth('café'), 4],
    ['日本', stringWidth('日本'), 4],
  ]
  for (const [s, got, want] of checks) {
    const ok = got === want
    if (!ok) failures++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] width("${s}") = ${got} (want ${want})`)
  }
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ WIDTH BENCH WITHIN FLOOR')
else console.log(`❌ ${failures} WIDTH BENCH CHECK(S) REGRESSED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
