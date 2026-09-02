#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-feel-journey.ts — the feel-pass REGRESSION JOURNEY
// one live PTY run through the new surfaces:
//
//    /appearance opens → ↓ previews the Light theme LOCALLY → Esc cancels
//    (restores the dark expression exactly) → the operator types a draft.
//
//  The FINAL frame must prove: the overlays were reversible (dark chrome
//  intact — no light leak, appearance center closed) and the prompt draft
//  survived the entire journey.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-feel-journey.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' Feel journey — appearance preview/cancel · draft')
console.log('============================================================')

const COLS = 110
const res = spawnSync(
  process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`,
  ['run', join(import.meta.dir, 'render-tui.ts'), '--scenario', 'feel-journey', '--cols', String(COLS), '--rows', '40'],
  { encoding: 'utf-8', timeout: 120000, env: { ...process.env } },
)
if (res.status !== 0) {
  console.log(`  [FAIL] journey capture ran — ${res.stderr || res.stdout || `status ${res.status}`}`)
  console.log('❌ FEEL-JOURNEY PROOF FAILED')
  process.exit(1)
}
type GridCell = { c?: string }
const g = JSON.parse(readFileSync(`/tmp/grid-${COLS}.json`, 'utf8')) as {
  grid: GridCell[][]
}
const text = g.grid.map(row => row.map(c => c.c ?? '').join('')).join('\n')

check('the prompt draft survived the overlay', text.includes('draft survives overlays'))
// Needles re-cut for the dark-only ruling: the picker heading
// changed with the single-row collapse, and the removed families must not
// paint ANYWHERE (removed from reach — not merely closed).
check('the appearance center is CLOSED (Esc unwound it)', !text.includes('The Mercury appearance'))
check('the removed families never paint (dark-only reach)', !text.includes('colorblind-friendly') && !text.includes('ANSI colors only') && !/\bLight\b/.test(text))
check('the transcript chrome is intact (session header + cockpit rail)', text.includes('SESSION') && text.includes('TELEMETRY'))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ FEEL-JOURNEY PROOF PASSES')
else {
  console.log(`❌ ${failures} FEEL-JOURNEY CHECK(S) FAILED`)
  process.exit(1)
}
