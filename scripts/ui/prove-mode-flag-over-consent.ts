#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

type Cell = { c: string }
type Grid = { grid: Cell[][] }
const rowsOf = (grid: Cell[][]): string[] => grid.map(row => row.map(cell => cell.c).join('').trimEnd())
const flat = (grid: Cell[][]): string => rowsOf(grid).join(' ').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')

console.log('============================================================')
console.log(' a typed --mode outranks the saved Sovereign mode row — the band')
console.log('============================================================')

const settingsPath = join(tmpdir(), `mode-flag-over-consent-${process.pid}.json`)
writeFileSync(settingsPath, JSON.stringify({ guardrails: { sovereignConsentSeen: true } }))
const cfg = scenario('mode-band-auto', 120, 40) as Record<string, unknown> & { argv: string[] }
const gridPath = `/tmp/mode-flag-over-consent-${process.pid}.json`
const cfgPath = `/tmp/mode-flag-over-consent-cfg-${process.pid}.json`
writeFileSync(cfgPath, JSON.stringify({ ...cfg, argv: [...cfg.argv, '--config', settingsPath], readyText: 'Type a prompt', stableTicks: 6, total: 60, out: gridPath }))
const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
  encoding: 'utf8',
  timeout: vshotBudgetMs(120_000),
  env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_SKIP_PERMISSIONS: '1' },
})
rmSync(cfgPath, { force: true })
rmSync(settingsPath, { force: true })
if (res.status !== 0) {
  check('PTY capture ran', false, res.stderr?.slice(0, 300) ?? '')
} else {
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  rmSync(gridPath, { force: true })
  const rows = rowsOf(grid)
  const band = rows.find(row => /flow on \(shift\+tab to cycle\)|sovereign mode on/.test(row)) ?? ''
  check('mercury --mode flow with the Sovereign mode row saved (MERCURY_SKIP_PERMISSIONS=1) opens in Flow: the band reads "flow on"', /flow on \(shift\+tab to cycle\)/.test(band), band || rows.filter(r => r.trim() !== '').slice(-6).join(' | '))
  check('…and never the crimson sovereign band', !/sovereign mode on/.test(band), band)
  check('the composer is on screen (the session opened, no consent card in the way)', flat(grid).includes('Type a prompt'), rows.filter(r => r.trim() !== '').slice(-6).join(' | '))
}
cleanupScenario('mode-band-auto')

console.log(`\n${failures === 0 ? '✅ the typed mode outranks the saved row — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
