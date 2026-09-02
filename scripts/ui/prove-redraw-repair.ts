#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const run = (sends: Array<{ atTick: number; data: string }>, out: string) => {
  const cfg = scenario('resume-2turn', 120, 44)
  const mine = { argv: cfg.argv, sends, total: 60, cols: 120, rows: 44, out }
  const cfgPath = `/tmp/redraw-proof-${process.pid}-${sends.length}.json`
  writeFileSync(cfgPath, JSON.stringify(mine))
  execFileSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
      MERCURY_AWAY_SUMMARY: '0',
    },
    stdio: 'ignore',
  })
  const g = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  const text = g.grid.map(r => r.map(c => c.c).join('')).join('\n')
  const rows = g.grid.map(r => r.map(c => c.c).join('').trimEnd()).filter(Boolean).length
  return { text, rows }
}

try {
  const base = run([], `/tmp/redraw-base-${process.pid}.json`)
  const healed = run([{ atTick: 20, data: String.fromCharCode(12) }], `/tmp/redraw-healed-${process.pid}.json`)
  t('baseline transcript paints (session header + turns)', base.rows >= 8 && base.text.includes('✶ SESSION') && base.text.includes('first task') && base.text.includes('second task'))
  t('ctrl+l keeps row parity', Math.abs(healed.rows - base.rows) <= 1, `healed=${healed.rows} base=${base.rows}`)
  for (const [name, marker] of [['session header', '✶ SESSION'], ['first task', 'first task'], ['second task', 'second task'], ['this session', 'this session']] as const) {
    t(`ctrl+l keeps '${name}'`, healed.text.includes(marker) === base.text.includes(marker))
  }
} finally {
  cleanupScenario('resume-2turn')
}

console.log(fail ? '❌ REDRAW-REPAIR RED' : '✅ REDRAW-REPAIR GREEN')
process.exit(fail)
