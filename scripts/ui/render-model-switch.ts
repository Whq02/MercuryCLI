#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-model-switch.ts — render-verify for the
//  model-switch mascot-vanish fix: a transcript holding ONLY local /model
//  chrome must still paint the FULL landing (mascot hero + lockup + session
//  table) with the command capsule beneath it — and a transcript with REAL
//  turns must collapse the landing FURNITURE (table · hints) while the
//  PERSISTENT hero stays (the critter is mounted outside the
//  hasTurns swap — the scrolled-junk fix survives as the furniture swap; the
//  mascot no longer dies to a glyph on the first turn).
//
//  Legs (vshot pyte PTY over the built binary; UI_RENDER=1 suite member):
//    model-switch-home @120 (cockpit)    : landing markers + hero sprite mass
//                                          + the `Set model to` capsule
//    model-switch-home @80  (deck-strip) : same landing survival off-cockpit
//    resume-2turn      @120 (counter)    : furniture ABSENT, hero PRESENT
//  Out: /tmp/model-switch-{120,80}.png + /tmp/model-switch-turns-120.png
// ============================================================================
import { writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { bigWordmarkRows } from '../../src/components/mercury-ui/assets.js'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')

type Cell = { c: string }
type Grid = { grid: Cell[][] }

function capture(scenarioName: string, cols: number, tag: string): Grid {
  const gridPath = `/tmp/model-switch-grid-${tag}.json`
  const cfg = { ...scenario(scenarioName, cols, 44), out: gridPath }
  const cfgPath = `/tmp/vshot-model-switch-${tag}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME }
  const painted = (g: Grid) => g.grid.reduce((n, r) => n + r.filter(c => c.c && c.c !== ' ').length, 0)
  let grid: Grid = { grid: [] }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(30000), env })
    if (res.status !== 0) continue
    grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
    if (painted(grid) >= 40) break
  }
  return grid
}

const text = (g: Grid) => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
// The hero sprite paints in half-block pixels — its cell mass is the honest
// "mascot is on screen" needle (the wordmark alone also appears in chrome).
const halfBlocks = (g: Grid) =>
  g.grid.reduce((n, r) => n + r.filter(c => c.c === '▀' || c.c === '▄' || c.c === '█').length, 0)

let failures = 0
function expect(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' model-switch landing render-verify (vshot, 80 & 120)')
console.log('============================================================')

// --- landing survives /model chrome @120 (cockpit) --------------------------
console.log('\n▶ model-switch-home @120 (cockpit — landing must survive)')
const c120 = capture('model-switch-home', 120, '120')
const t120 = text(c120)
gridToPng('/tmp/model-switch-grid-120.json', '/tmp/model-switch-120.png').then(r => console.log('  png:', r.path))
// Needle discipline: 'type a prompt' is USELESS here — the prompt
// placeholder ('tab focuses the rails · type a prompt, or / for commands')
// carries it on every screen. Landing-distinctive needles instead: the
// prompt-hint row's '↵ sends', the session table's theme row, and the hero
// sprite's half-block cell mass (the brand-row crab marks total ~20 cells;
// the 24×9 hero is >100 — 60 discriminates).
expect('landing prompt-hint row present (`↵ sends`)', /↵ sends/.test(t120))
expect('landing session table present (theme row)', /theme\s+\w/.test(t120))
expect('mascot hero sprite mass on screen (≥60 half-block cells)', halfBlocks(c120) >= 60)
expect('the /model capsule painted beneath the landing (`Set model to Sonnet 5`)',
  /Set model to Sonnet 5/.test(t120))
expect('the command breadcrumb painted (`/model`)', /\/model/.test(t120))

// --- landing survives /model chrome @80 (deck-strip home) -------------------
console.log('\n▶ model-switch-home @80 (deck-strip — same survival off-cockpit)')
const c80 = capture('model-switch-home', 80, '80')
const t80 = text(c80)
gridToPng('/tmp/model-switch-grid-80.json', '/tmp/model-switch-80.png').then(r => console.log('  png:', r.path))
expect('@80: landing prompt-hint row present (`↵ sends`)', /↵ sends/.test(t80))
expect('@80: landing session table present (theme row)', /theme\s+\w/.test(t80))
expect('@80: mascot hero sprite mass on screen (≥60 half-block cells)', halfBlocks(c80) >= 60)
expect('@80: the /model capsule painted', /Set model to Sonnet 5/.test(t80))

// --- counter-leg: REAL turns collapse the FURNITURE, keep the hero ----------
console.log('\n▶ resume-2turn @120 (counter — furniture collapses, the hero persists)')
const turns120 = capture('resume-2turn', 120, 'turns-120')
const tt120 = text(turns120)
gridToPng('/tmp/model-switch-grid-turns-120.json', '/tmp/model-switch-turns-120.png').then(r => console.log('  png:', r.path))
expect('landing prompt-hint ABSENT with real turns (furniture collapse intact)', !/↵ sends/.test(tt120))
expect('landing session table ABSENT with real turns', !/theme\s+\w/.test(tt120))
// persistent hero: the mascot stays mounted with turns — the same
// ≥60 half-block discriminator the landing legs use (brand-row-era cells were
// ~20; the 24-wide hero is >100).
expect('hero sprite mass PRESENT with real turns (persistent hero, ≥60)', halfBlocks(turns120) >= 60)
// Single-brand pass: the turns furniture at 120×44 is the block
// MERCURY banner-header (bigWordmarkRows) — never the crab glyph collapse.
expect('the banner-header painted (never the crab glyph collapse)', tt120.includes(bigWordmarkRows()[0]!.trimEnd()))
expect('the real turns painted (`first task`)', /first task/.test(tt120))

cleanupScenario('model-switch-home')
cleanupScenario('resume-2turn')

console.log('\n============================================================')
if (failures === 0) console.log('✅ MODEL-SWITCH RENDER PASS')
else console.log(`❌ MODEL-SWITCH RENDER: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
