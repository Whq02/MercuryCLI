#!/usr/bin/env bun
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
  const v = aggregateVelocity([at(10), at(20), at(30), at(300)], NOW)
  check('newest bin (idx 13) has the 3 recent calls', v.perMin[13] === 3, `${v.perMin[13]}`)
  check('the 5-min-ago call lands in bin 9', v.perMin[9] === 1, `${v.perMin[9]}`)
  check('total 4 · peak 3', v.total === 4 && v.peakPerMin === 3)
  check('idle ≈ 10s (newest call)', v.idleSec === 10, `${v.idleSec}`)
}

section('trend: rising / falling / steady')
{
  const rising = aggregateVelocity([at(20), at(40), at(60), at(80)], NOW)
  check("recent burst ⇒ 'rising'", rising.trend === 'rising', rising.trend)
  const falling = aggregateVelocity([at(740), at(760), at(780), at(800)], NOW)
  check("early burst, quiet now ⇒ 'falling'", falling.trend === 'falling', falling.trend)
  const steady = aggregateVelocity([at(60), at(120), at(720), at(780)], NOW)
  check("balanced ends ⇒ 'steady'", steady.trend === 'steady', steady.trend)
}

section('out-of-window call: not binned, but idle still honest (quiet away-run)')
{
  const v = aggregateVelocity([at(1200)], NOW)
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
        at(-120),
        { ts: 'not-a-date', tool: 'X', surface: 's', risk: 'low' } as never,
        at(30),
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
  check('TraceView computes the pulse (aggregateVelocity)', /aggregateVelocity\(records, now\)/.test(tv))
  check('TraceView renders the Sparkline pulse row', /<Sparkline values=\{pulse\.perMin\}/.test(tv))
  check('pulse row is gated on having activity (pulse.total > 0)', /pulse\.total > 0/.test(tv))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SESSION-PULSE PROOFS PASS')
else console.log(`❌ ${failures} SESSION-PULSE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
