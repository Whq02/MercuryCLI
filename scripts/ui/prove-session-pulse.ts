#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-session-pulse.ts
//  PROOF: the Session Pulse (the /trace velocity sparkline) is correct + honest.
//  aggregateVelocity() bins invocation traces by their ISO ts into a recent
//  window — the "WHEN / how fast" a long autonomous run can't read off the
//  last-N table. Pure (a clock value in, bins/trend/idle out), so it's provable
//  here WITHOUT racing real time: a fixed nowMs makes every bin deterministic.
//    • empty ⇒ honest-zero (no bins, steady, idle 0 — never an invented pulse);
//    • binning lands calls in the right minute slot; out-of-window calls don't bin
//      but STILL report idle (an away-run that went quiet shows a long idle);
//    • trend reads rising/falling/steady from recent-third vs earliest-third;
//    • future / NaN timestamps are ignored (never throw, never a fake "just active").
//  Plus a wiring guard: the dead SPARK ramp is now CONSUMED (Sparkline) and the
//  pulse row is rendered in TraceView.
//  Run: ~/.bun/bin/bun run scripts/ui/prove-session-pulse.ts
// ============================================================================
import { plugin } from 'bun'
plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateVelocity } from '../../src/utils/cockpit/traceSnapshot.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const NOW = Date.parse('2026-06-19T12:00:00.000Z')
// a trace record at `agoSec` seconds before NOW (only ts matters to the aggregator)
const at = (agoSec: number): { ts: string; tool: string; surface: string; risk: string } => ({
  ts: new Date(NOW - agoSec * 1000).toISOString(),
  tool: 'Bash',
  surface: 'shell',
  risk: 'low',
})

console.log('============================================================')
console.log(' Session Pulse — aggregateVelocity (render-free, deterministic)')
console.log('============================================================')

section('empty ⇒ honest-zero (never an invented pulse)')
{
  const v = aggregateVelocity([], NOW)
  check('14 bins, all zero', v.perMin.length === 14 && v.perMin.every(n => n === 0))
  check('total 0 · peak 0', v.total === 0 && v.peakPerMin === 0)
  check("trend 'steady'", v.trend === 'steady')
  check('idle 0', v.idleSec === 0)
}

section('binning lands calls in the right minute slot')
{
  // 3 calls in the last minute + 1 call 5 minutes ago (default bins=14, binMs=60s)
  const v = aggregateVelocity([at(10), at(20), at(30), at(300)], NOW)
  check('newest bin (idx 13) has the 3 recent calls', v.perMin[13] === 3, `${v.perMin[13]}`)
  check('the 5-min-ago call lands in bin 9', v.perMin[9] === 1, `${v.perMin[9]}`)
  check('total 4 · peak 3', v.total === 4 && v.peakPerMin === 3)
  check('idle ≈ 10s (newest call)', v.idleSec === 10, `${v.idleSec}`)
}

section('trend: rising / falling / steady')
{
  const rising = aggregateVelocity([at(20), at(40), at(60), at(80)], NOW) // all recent
  check("recent burst ⇒ 'rising'", rising.trend === 'rising', rising.trend)
  const falling = aggregateVelocity([at(740), at(760), at(780), at(800)], NOW) // all early (~13 min ago)
  check("early burst, quiet now ⇒ 'falling'", falling.trend === 'falling', falling.trend)
  const steady = aggregateVelocity([at(60), at(120), at(720), at(780)], NOW) // even-ish ends
  check("balanced ends ⇒ 'steady'", steady.trend === 'steady', steady.trend)
}

section('out-of-window call: not binned, but idle still honest (quiet away-run)')
{
  const v = aggregateVelocity([at(1200)], NOW) // 20 min ago, window is 14 min
  check('not binned (total 0)', v.total === 0 && v.peakPerMin === 0)
  check('idle reflects the real last activity (1200s)', v.idleSec === 1200, `${v.idleSec}`)
}

section('future / NaN timestamps are ignored (never throw, never fake-active)')
{
  let threw = false
  let v: ReturnType<typeof aggregateVelocity> | null = null
  try {
    v = aggregateVelocity(
      [
        at(-120), // 2 min in the FUTURE (clock skew) → ignored
        { ts: 'not-a-date', tool: 'X', surface: 's', risk: 'low' } as never,
        at(30), // a real recent call
      ],
      NOW,
    )
  } catch {
    threw = true
  }
  check('did not throw on garbage/future ts', !threw)
  check('only the real call counted (total 1)', v?.total === 1, `${v?.total}`)
  check('future ts did NOT reset idle to 0 (idle ≈ 30s)', v?.idleSec === 30, `${v?.idleSec}`)
}

section('wiring: the dead SPARK ramp is now CONSUMED + rendered')
{
  const comp = src('components', 'mercury-ui', 'components.tsx')
  check('Sparkline primitive exported', /export function Sparkline\(/.test(comp))
  check('Sparkline consumes the SPARK ramp', /SPARK\[/.test(comp) && /from '\.\/glyphs\.js'/.test(comp) && /SPARK/.test(comp))
  const tv = src('components', 'TraceView.tsx')
  // trust-cockpit W2a: the pulse's clock is the shared useNowTick value (ages
  // tick instead of freezing at mount) — the call shape is (records, now).
  check('TraceView computes the pulse (aggregateVelocity)', /aggregateVelocity\(records, now\)/.test(tv))
  check('TraceView renders the Sparkline pulse row', /<Sparkline values=\{pulse\.perMin\}/.test(tv))
  check('pulse row is gated on having activity (pulse.total > 0)', /pulse\.total > 0/.test(tv))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SESSION-PULSE PROOFS PASS')
else console.log(`❌ ${failures} SESSION-PULSE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
