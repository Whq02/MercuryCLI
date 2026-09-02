#!/usr/bin/env bun
import { stringWidth } from '../../src/ink/stringWidth.js'
import { truncateToWidth } from '../../src/utils/truncate.js'

let failures = 0
const SLACK = Math.max(1, Number(process.env.MERCURY_BENCH_SLACK) || 1)

const SAMPLES = [
  'realm  orchard-src  ⌥main · clean',
  'MCP policy gate          MERCURY_MCP_MAX_RISK=low|medium',
  '● Capability manifest   always-on (fork) · ToolSearch',
  'café 日本語 ▖▟▆▙▗ ●○◐◆◉ résumé',
  'a'.repeat(120),
]

function bench(label: string, fn: () => void, iters: number, floorOpsSec: number): void {
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
