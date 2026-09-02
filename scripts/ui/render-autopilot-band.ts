#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-autopilot-band.ts — render-verify for the AUTOPILOT
//  modeBand: a real PTY boot with --dangerously-skip-permissions
//  (bypass mode) + MERCURY_AUTOPILOT=1, one REAL shift+tab into autopilot, and
//  the MercuryFrame band must paint the bypass-family alarm + the live tier:
//    ⌖ autopilot on — permissions bypassed · self-tier armed · <model>
//  No mock: the same carousel, guards, and band the operator sees.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-autopilot-band.ts
//  Out:  /tmp/autopilot-band-{80,120}.png + PASS/FAIL (exit 1 on FAIL).
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, scenario } from './renderScenarios.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const NAME = 'autopilot-band'
const VSHOT = join(import.meta.dir, 'vshot.py')

type Cell = { c: string }
type Grid = { grid: Cell[][] }

function capture(cols: number): Grid {
  const gridPath = `/tmp/autopilot-band-grid-${cols}.json`
  const cfg = { ...scenario(NAME, cols, 40), out: gridPath }
  const cfgPath = `/tmp/vshot-autopilot-band-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_AUTOPILOT: '1',
  }
  const painted = (g: Grid) =>
    g.grid.reduce((n, r) => n + r.filter(c => c.c && c.c !== ' ').length, 0)
  let grid: Grid = { grid: [] }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(60000),
      env,
    })
    if (res.status !== 0) continue
    grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
    if (painted(grid) >= 40) break
  }
  return grid
}

const text = (g: Grid) => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

let failures = 0
function expect(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' AUTOPILOT modeBand render-verify (real shift+tab @80 + @120)')
console.log('============================================================')

for (const cols of [80, 120] as const) {
  const g = capture(cols)
  const t = text(g)
  void gridToPng(`/tmp/autopilot-band-grid-${cols}.json`, `/tmp/autopilot-band-${cols}.png`).then(
    r => console.log('  png:', r.path),
  )
  console.log(`\n  — ${cols} cols —`)
  expect(`@${cols}: the ⌖ reticle paints (the autopilot mode-seal)`, t.includes('⌖'))
  expect(`@${cols}: 'autopilot on' band present`, t.includes('autopilot on'))
  expect(`@${cols}: names the posture (permissions bypassed)`, t.includes('permissions bypassed'))
  expect(
    // The plain bypass band reads "sovereign
    // mode on" — the not-still-bypass check follows the display copy.
    `@${cols}: NOT still the plain sovereign (bypass) band (the shift+tab landed)`,
    !t.includes('sovereign mode on'),
  )
  if (cols === 120) {
    expect('@120: the live tier readout tail present (self-tier armed ·)', t.includes('self-tier armed'))
  }
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
