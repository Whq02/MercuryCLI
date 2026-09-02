// ============================================================================
//  prove-snapshot-contract — the substrate snapshot bridges honor their core
//  contract: "honest state, never throws" (the substrate contract). Every
//  UI surface (MercuryFrame, DeckPane, /deck, /fleet, …) reads a Snapshot<T> from
//  utils/cockpit/* and must NEVER get an exception — a missing/unreadable backend
//  is a labelled UI state, not a crash. This locks that in as a regression guard:
//  each bridge, in BOTH fork states, must return an object with a non-empty string
//  `state` and must not throw.
//
//  Each bridge file is imported DIRECTLY (the same reason the umbrella proof
//  imports substrateSnapshot.js directly). color-diff-napi is stubbed via
//  Bun.plugin + dynamic import (see memory/bun-run-proof-loadability).
//  globalThis.MACRO stamp-sim per prove-substrate-umbrella.ts. The gauges that
//  take arguments (modelGauge, contextGauge) are called bare: an unresolvable
//  input must be an honest `unavailable`, never a throw.
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

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

const BASE = '../../src/utils/cockpit/'
// (file, exportName). Every bridge that loads directly under bun-run (sync + async; we
// `await` uniformly, which is a no-op for the sync ones).
const BRIDGES: Array<[string, string]> = [
  ['substrateSnapshot', 'substrateSnapshot'],
  ['permissionsSnapshot', 'permissionsSnapshot'],
  ['mcpGauge', 'mcpGauge'],
  ['daemonSnapshot', 'daemonSnapshot'],
  ['fleetGauge', 'fleetGauge'],
  ['traceSnapshot', 'traceSnapshot'],
  ['gitSnapshot', 'gitSnapshot'],
  ['modelGauge', 'modelGauge'],
  ['contextGauge', 'contextGauge'],
]

let fail = 0
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) fail = 1
}

console.log('============================================================')
console.log(' Substrate snapshot bridges — honest-state-never-throws contract')
console.log('============================================================')

const VALID = new Set(['live', 'off', 'unavailable'])

for (const fork of [true, false]) {
  setStamp(fork)
  console.log(`\n[${fork ? 'fork' : 'bare-stamp'}] each bridge returns a labelled state, no throw`)
  for (const [file, exportName] of BRIDGES) {
    const mod = await import(BASE + file + '.js')
    const fn = mod[exportName]
    if (typeof fn !== 'function') {
      check(`${exportName}: exported as a function`, false)
      continue
    }
    let ok = false
    let detail = ''
    try {
      const r = await fn()
      ok = !!r && typeof r === 'object' && typeof r.state === 'string' && r.state.length > 0
      detail = ok ? `state='${r.state}'${VALID.has(r.state) ? '' : ' (non-canonical)'}` : `bad shape: ${JSON.stringify(r)?.slice(0, 60)}`
    } catch (e) {
      ok = false
      detail = `THREW: ${(e as Error).message?.split('\n')[0]}`
    }
    check(`${exportName} → ${detail}`, ok)
  }
}

console.log('\n============================================================')
console.log(fail === 0 ? ` ✅ SNAPSHOT CONTRACT HOLDS (${BRIDGES.length} bridges, both fork states)` : ' ❌ SNAPSHOT CONTRACT VIOLATED')
console.log('============================================================')
process.exit(fail)
