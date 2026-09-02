#!/usr/bin/env bun
// ============================================================================
//  render-nochange-cards — the honest no-change result cards on
//  the BUILT artifact, rendered at 80 + 120 columns (the render-verify law —
//  a broken layout only shows in a render):
//    · the identical-hunk Edit paints the dim "No changes — … already
//      matches" row (never the update/diff card);
//    · the byte-identical Write paints the same honest row (never the
//      "Wrote N lines" create card);
//    · no card claims an update and no diff gutter renders for either.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'stillpoint-cards-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][] }
const textOf = (g: Grid): string => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function capture(name: string, cols: number): string {
  const cfg = scenario(name, cols, 44)
  const out = join(home, `${name}-${cols}.json`)
  const cfgPath = join(home, `${name}-${cols}-cfg.json`)
  // OBSERVED-READY (the PTY-capture law): the capture ends when the no-change
  // row actually paints; the hard deadline (total) covers a cold 2-core CI
  // runner booting the 20 MB bundle + resume — a fixed 45-tick (9 s) budget
  // is exactly the hosted-runner failing class (grid rendered, transcript
  // not yet painted, 0 rows).
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends: cfg.sends ?? [], total: 150, readyText: ['already matches'], cols, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home },
  })
  if (res.status !== 0) throw new Error(`vshot ${name} failed: ${res.stderr?.slice(-500)}`)
  return textOf(JSON.parse(readFileSync(out, 'utf8')) as Grid)
}

try {
  for (const cols of [120, 80]) {
    console.log(`── nochange-cards at ${cols} ──`)
    const grid = capture('nochange-cards', cols)
    const noChangeRows = grid.split('\n').filter(l => l.includes('No changes — stillpoint-demo.txt already matches'))
    t(`both no-change rows paint at ${cols}`, noChangeRows.length === 2, `${noChangeRows.length} row(s)`)
    if (noChangeRows.length !== 2) {
      // Self-diagnosing red: name what the grid actually held (bounded).
      console.log('      ┌ grid on failure (first 30 non-blank lines):')
      for (const line of grid.split('\n').filter(l => l.trim()).slice(0, 30)) {
        console.log(`      │ ${line.slice(0, 110)}`)
      }
    }
    t(`no update claim at ${cols}`, !/Updated .*stillpoint-demo/.test(grid) && !grid.includes('has been updated'))
    t(`no create claim at ${cols}`, !/Wrote \d+ lines? to/.test(grid))
    t(`no diff gutter for the no-change pair at ${cols}`, !grid.includes('- alpha') && !grid.includes('+ alpha'))
    t(`hero glance never claims a changed file at ${cols}`, !grid.includes('file changed'))
  }
} finally {
  try {
    cleanupScenario()
  } catch {
    /* fixture cleanup is best-effort */
  }
}

console.log(failures === 0 ? '\nrender-nochange-cards: GREEN' : '\nrender-nochange-cards: RED')
process.exit(failures)
