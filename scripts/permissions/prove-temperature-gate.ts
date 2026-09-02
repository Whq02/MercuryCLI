// ============================================================================
//  prove-temperature-gate — modelSupportsTemperature over the input space.
//
//  The gate protects every temperature-sending seam (the auto-mode classifier's
//  side query above all). It has now been wrong TWICE, each time discovered by
//  a live 400 storm: run #3 — 5-family models rejected the
//  param but the seam always sent it; the bench calibration (same day PM) —
//  the fix gated only major ≥ 5, but sampling params were REMOVED at Opus 4.7,
//  so claude-opus-4-8 still got temperature → 400 → "temporarily unavailable"
//  → auto mode write-dead on every opus session. A gate primitive gets its
//  input space enumerated (the fable-audit commit-gate lesson).
// ============================================================================
import { modelSupportsTemperature } from '../../src/utils/betas.ts'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

const CASES: Array<[string, boolean, string]> = [
  // the live-400 offenders
  ['claude-opus-4-8', false, 'opus 4.8 — the bench-calibration 400'],
  ['claude-opus-4-8[1m]', false, 'opus 4.8 with the 1m ctx suffix'],
  ['claude-opus-4-7', false, 'opus 4.7 — where sampling params were removed'],
  ['claude-sonnet-5', false, 'sonnet 5 — the run-#3 400'],
  ['claude-fable-5', false, 'fable 5'],
  ['claude-mythos-5', false, 'mythos 5'],
  ['claude-opus-5', false, 'hypothetical opus 5'],
  ['claude-opus-4-10', false, 'hypothetical opus 4.10 (minor ≥ 7)'],
  // still-supported models — the gate must NOT over-drop
  ['claude-opus-4-6', true, 'opus 4.6 keeps temperature'],
  ['claude-opus-4-5', true, 'opus 4.5'],
  ['claude-opus-4-5-20251101', true, 'opus 4.5 dated snapshot'],
  ['claude-opus-4-1-20250805', true, 'opus 4.1 dated snapshot (minor 1, then date)'],
  ['claude-opus-4-20250514', true, 'opus 4.0 DATED id — the date is not a minor'],
  ['claude-sonnet-4-6', true, 'sonnet 4.6'],
  ['claude-sonnet-4-5-20250929', true, 'sonnet 4.5 dated snapshot'],
  ['claude-haiku-4-5-20251001', true, 'haiku 4.5 dated snapshot'],
  ['claude-3-5-sonnet-20241022', true, 'legacy 3.5 id shape (no family match)'],
  ['claude-3-haiku-20240307', true, 'legacy 3.0 id shape'],
  // non-matching passthrough
  ['gpt-4', true, 'non-claude id passes through unchanged'],
  ['', true, 'empty string passes through'],
]

for (const [model, expected, why] of CASES) {
  const got = modelSupportsTemperature(model)
  check(got === expected, `${model || '(empty)'} → ${got} (${why})`)
}

console.log(failures === 0 ? '\n✅ TEMPERATURE-GATE MATRIX PASSES' : `\n❌ FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
