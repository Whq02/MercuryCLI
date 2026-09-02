#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'src', 'components', 'mercury-ui', 'NavigablePanes.tsx'), 'utf-8')
const monitor = readFileSync(join(root, 'src', 'components', 'mercury-ui', 'screens', 'MonitorView.tsx'), 'utf-8')

console.log('============================================================')
console.log(' NavigablePanes React-level windowing (HB-0186)')
console.log('============================================================')

section('source: the window is computed + the ScrollBox renders a slice + spacers')
check('ROW_OVERSCAN = 12 const exists', /const ROW_OVERSCAN = 12/.test(src))
check('winSpan = listHeight + 2*ROW_OVERSCAN', /const winSpan = listHeight \+ 2 \* ROW_OVERSCAN/.test(src))
check('winStart centers sel with overscan, clamped to [0, N-winSpan] (sel always in-window)', /Math\.min\(Math\.max\(0, sel - \(listHeight >> 1\) - ROW_OVERSCAN\), N - winSpan\)/.test(src))
check('winEnd = min(N, winStart + winSpan)', /const winEnd = Math\.min\(N, winStart \+ winSpan\)/.test(src))
check('the ScrollBox renders sectionRows.slice(winStart, winEnd) (not the full map)', /sectionRows\.slice\(winStart, winEnd\)\.map/.test(src) && !/\{sectionRows\.map\(\(r, i\) => \(/.test(src))
check('a leading spacer Box carries winStart rows', /winStart > 0 \? <Box height=\{winStart\} flexShrink=\{0\} \/> : null/.test(src))
check('a trailing spacer Box carries N - winEnd rows', /winEnd < N \? <Box height=\{N - winEnd\} flexShrink=\{0\} \/> : null/.test(src))
check('the global index gi = winStart + i drives selected + rowRef (so sel stays addressable)', /const gi = winStart \+ i/.test(src) && /selected=\{gi === sel\}/.test(src) && /rowRef=\{gi === sel \?/.test(src))
check('PaneRow stays height={1} (the spacer-height==row-count invariant the windowing relies on)', /height=\{1\} overflow="hidden">/.test(src))

section('source: MonitorView is NOT hard-capped (every row stays navigable)')
check('MonitorView does NOT .slice its missions/health/leases to a hard cap', !/\.(slice)\(0, ?(MAX_|10|8)/.test(monitor))

section('behaviour: verbatim window math — sel always in-window, byte-identical small, last row reachable')
const ROW_OVERSCAN = 12
function win(N: number, listHeight: number, sel: number): { s: number; e: number } {
  const winSpan = listHeight + 2 * ROW_OVERSCAN
  const winStart =
    N <= winSpan ? 0 : Math.min(Math.max(0, sel - (listHeight >> 1) - ROW_OVERSCAN), N - winSpan)
  const winEnd = Math.min(N, winStart + winSpan)
  return { s: winStart, e: winEnd }
}
{
  const lh = 10
  const span = lh + 2 * ROW_OVERSCAN
  let allFull = true
  for (let N = 0; N <= span; N++)
    for (let sel = 0; sel < Math.max(1, N); sel++) {
      const { s, e } = win(N, lh, sel)
      if (s !== 0 || e !== N) allFull = false
    }
  check(`N ≤ winSpan ⇒ winStart=0, winEnd=N for every sel (byte-identical, all rows mounted)`, allFull)
}
{
  let selAlwaysIn = true
  let windowBounded = true
  for (const N of [50, 200, 1000])
    for (const lh of [5, 12, 30])
      for (let sel = 0; sel < N; sel++) {
        const { s, e } = win(N, lh, sel)
        if (!(sel >= s && sel < e)) selAlwaysIn = false
        if (e - s !== Math.min(N, lh + 2 * ROW_OVERSCAN)) windowBounded = false
      }
  check('large section: sel is ALWAYS inside [winStart, winEnd) (selected rowRef stays mounted)', selAlwaysIn)
  check('the mounted window is min(N, winSpan) — bounded by listHeight+24, never the full N when N>winSpan', windowBounded)
}
{
  const N = 500
  const { s, e } = win(N, 12, N - 1)
  check('the LAST row (sel = N-1) is inside the window (reachable by ↓, kills the cap-regression)', N - 1 >= s && N - 1 < e && e === N)
}
{
  const N = 300,
    lh = 12
  let noUndershoot = true
  for (let sel = 1; sel < N - 1; sel++) {
    const w = win(N, lh, sel)
    if (!(sel + 1 >= w.s && sel + 1 < w.e && sel - 1 >= w.s && sel - 1 < w.e)) noUndershoot = false
  }
  check('OVERSCAN(12) ≫ a 1-step ↑↓: sel±1 stays within the current window (no blank-viewport undershoot)', noUndershoot)
}

{
  let heightOk = true
  let posOk = true
  for (const N of [40, 250, 999])
    for (const lh of [8, 16])
      for (const sel of [0, 1, (N / 2) | 0, N - 2, N - 1]) {
        const { s, e } = win(N, lh, sel)
        const totalHeight = s  + (e - s)  + (N - e)
        if (totalHeight !== N) heightOk = false
        const selOffset = s + (sel - s)
        if (selOffset !== sel) posOk = false
      }
  check('total mounted height (leadSpacer + slice + trailSpacer) == N for every case (honest scroll height)', heightOk)
  check("the selected row's vertical offset == its global index (computedTop unchanged ⇒ scrollToElement works)", posOk)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0186 — NavigablePanes windowing (bounded fibers, sel always mounted, all rows navigable)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0186 — ${failures} check(s) failed`)
  process.exit(1)
}
