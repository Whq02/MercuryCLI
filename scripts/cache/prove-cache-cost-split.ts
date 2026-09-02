#!/usr/bin/env bun
// ============================================================================
//  scripts/cache/prove-cache-cost-split.ts
//  PROOF: local cost accounting prices 1h cache writes at the API's 2× input
//  premium when the usage split is present, and stays byte-for-byte on the
//  flat 1.25× behavior when it is absent (the split law — where it
//  lives → modelCost). Drives the REAL exported calculateUSDCost.
//  Run:  ~/.bun/bin/bun run scripts/cache/prove-cache-cost-split.ts
// ============================================================================

// calculateUSDCost → getModelCosts touches bootstrap state on unknown models;
// use a real Opus 4.5 id (COST_TIER_5_25: $5 in / $6.25 write / $0.5 read).
const { calculateUSDCost } = await import('../../src/utils/modelCost.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const MODEL = 'claude-opus-4-5'
const M = 1_000_000
type U = Parameters<typeof calculateUSDCost>[1]
function usage(partial: Partial<U>): U {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...partial,
  } as U
}
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6
}

console.log('============================================================')
console.log(' modelCost 1h cache-write split — proof')
console.log('============================================================')

const flat = calculateUSDCost(MODEL, usage({ cache_creation_input_tokens: M }))
check('no split ⇒ flat 5m write price ($6.25/M unchanged)', near(flat, 6.25), String(flat))

const all5m = calculateUSDCost(
  MODEL,
  usage({
    cache_creation_input_tokens: M,
    cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 },
  } as Partial<U>),
)
check('split all-5m ⇒ identical to flat ($6.25)', near(all5m, 6.25), String(all5m))

const all1h = calculateUSDCost(
  MODEL,
  usage({
    cache_creation_input_tokens: M,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M },
  } as Partial<U>),
)
check('split all-1h ⇒ 2× input ($10.00)', near(all1h, 10), String(all1h))

const mixed = calculateUSDCost(
  MODEL,
  usage({
    cache_creation_input_tokens: M,
    cache_creation: { ephemeral_5m_input_tokens: M / 2, ephemeral_1h_input_tokens: M / 2 },
  } as Partial<U>),
)
check('mixed 50/50 ⇒ $3.125 + $5.00 = $8.125', near(mixed, 8.125), String(mixed))

const clamped = calculateUSDCost(
  MODEL,
  usage({
    cache_creation_input_tokens: M,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2 * M },
  } as Partial<U>),
)
check('1h split clamped to the reported total (no double-billing)', near(clamped, 10), String(clamped))

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ cost split proof: all checks pass')
