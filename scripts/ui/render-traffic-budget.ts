#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-traffic-budget.ts — UI_RENDER-tier regression ratchet for
//  the REPL smoothness pass: re-runs the render-traffic oracle in
//  BUDGET mode and fails if any in-turn animation scene exceeds its writes/s
//  ceiling (a re-storm — e.g. a raw-tick continuous color wave — trips it;
//  pre-fix baselines were 2-2.5× the ceilings). Detail + scene definitions:
//  measure-render-traffic.ts (runnable standalone for full numbers).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const r = spawnSync(
  process.execPath,
  ['run', join(HERE, 'measure-render-traffic.ts'), 'turn-thinking', 'turn-tools', 'turn-responding'],
  {
    env: { ...process.env, MEASURE_BUDGET: '1', MEASURE_SECONDS: '8' },
    stdio: 'inherit',
    timeout: 240_000,
  },
)
process.exit(r.status ?? 1)
