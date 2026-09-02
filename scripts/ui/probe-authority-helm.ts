#!/usr/bin/env bun
// STALE-PAINT emission-boundary probe driver: run the authority scenario with
// the HELM CLAIM PATH ON (undoing the scenario's deliberate pin), tee raw PTY
// bytes, and stop at the first run whose FINAL grid shows the stale detail row.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const VSHOT = new URL('./vshot.py', import.meta.url).pathname

for (let run = 1; run <= 6; run++) {
  const grid = `/tmp/probe-grid-${run}.json`
  const tee = `/tmp/probe-tee-${run}.bin`
  try { rmSync(tee) } catch {}
  const cfg = { ...scenario('authority', 120, 44), out: grid }
  process.env.MERCURY_HELM_HOME = '1' // probe the CLAIM path (undo the scenario pin)
  writeFileSync(`/tmp/probe-cfg-${run}.json`, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, `/tmp/probe-cfg-${run}.json`], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(60000),
    env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, VSHOT_TEE: tee },
  })
  cleanupScenario('authority')
  if (res.status !== 0) { console.log(`run ${run}: vshot failed`); continue }
  const g = JSON.parse(readFileSync(grid, 'utf8')) as { grid: { c: string }[][] }
  const text = g.grid.map(r => r.map(c => c.c).join('')).join('\n')
  const good = text.includes('Asks you to trust a new MCP server')
  const staleRisk = text.includes('A kill is absolute')
  console.log(`run ${run}: detail-correct=${good} stale-risk-line=${staleRisk}`)
  if (!good || staleRisk) {
    console.log(`REPRODUCED at run ${run} — tee: ${tee} grid: ${grid}`)
    process.exit(0)
  }
}
console.log('no repro in 6 runs')
