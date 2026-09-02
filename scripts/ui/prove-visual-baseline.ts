#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-visual-baseline.ts — the baseline COMPARISON is
//  suite-reachable.
//
//  generate-visual-baseline.ts was the only thing that re-captures the
//  committed grids against the live product, and no runner globbed it (the
//  same orphaned-glob class its own header records) — so a rendering
//  regression in a non-dark family had NO standing proof. This prover closes
//  that: every pooled run re-captures a BOUNDED cross-family spot set (the
//  cockpit frame in light, daltonized and ansi — the families the dark-run
//  provers never see) and compares against the stored grids through the
//  mask-aware digests; UI_RENDER=1 runs the FULL 48-entry sweep.
//
//  Cost discipline: three PTY boots in the pooled lane (~30-45 s), the whole
//  matrix only in the render-class lane.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'

const FULL = process.env.UI_RENDER === '1'
const SPOTS = [
  'frame--120x40--light--truecolor--full',
  'frame--120x40--light-daltonized--truecolor--full',
  'frame--120x40--dark--ansi--full',
]

let fail = 0
const run = (only?: string): void => {
  const args = ['run', 'scripts/ui/generate-visual-baseline.ts', '--check']
  if (only) args.push('--only', only)
  const r = spawnSync(process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`, args, {
    encoding: 'utf8',
    timeout: FULL ? 1_800_000 : 300_000,
  })
  const tail = (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-3).join(' · ')
  const ok = r.status === 0
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] baseline check ${only ?? 'FULL MATRIX'} — ${tail}`)
  if (!ok) fail = 1
}

console.log('visual baseline — the committed grids match the live product')
if (FULL) {
  run()
} else {
  for (const id of SPOTS) run(id)
}

if (fail) {
  console.log('❌ visual-baseline comparison RED')
  process.exit(1)
}
console.log('✅ visual-baseline comparison green')
