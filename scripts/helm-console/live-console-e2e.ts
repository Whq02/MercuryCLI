#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenario, cleanupScenario } from '../ui/renderScenarios.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
type Grid = { grid: Array<Array<{ c: string }>> }

function capture(cfg: object, gridPath: string): Grid | null {
  writeFileSync('/tmp/vshot-live-console.json', JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync(
    '/usr/bin/python3',
    [join(ROOT, 'scripts/ui/vshot.py'), '/tmp/vshot-live-console.json'],
    { encoding: 'utf8', timeout: vshotBudgetMs(120_000), env: { ...process.env } },
  )
  if (res.status !== 0) {
    console.log(`  [FAIL] vshot exited ${res.status}: ${(res.stderr ?? '').slice(0, 300)}`)
    failures++
    return null
  }
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
}

console.log('============================================================')
console.log(' LIVE console E2E — real binary · real ↵ · real usage')
console.log('============================================================')

{
  const base = scenario('frame', 160, 50)
  const cfg = {
    ...base,
    sends: [
      { atTick: 30, data: '/console' },
      { atTick: 38, data: '\r' },
      { atTick: 44, data: 'Reply with exactly the single word: pong' },
      { atTick: 52, data: '\r' },
    ],
    total: 235,
  }
  const g = capture(cfg, '/tmp/grid-live-console.json')
  cleanupScenario('frame')
  if (g) {
    const lines = g.grid.map(row => row.map(c => c.c ?? '').join(''))
    const text = lines.join('\n')
    check('question echoed on the surface', text.includes('Reply with exactly'))
    check('REAL answer landed on the surface', /\bpong\b/i.test(text))
    const receiptLine = lines.find(l => /\d+s · \d[\d.]*[km]?→\d/.test(l)) ?? ''
    check('receipt row painted (duration · tokens)', receiptLine !== '', lines.filter(l => l.includes('tok')).join(' | ').slice(0, 120))
    await gridToPng('/tmp/grid-live-console.json', '/tmp/live-console-answer.png')
    console.log('  (png: /tmp/live-console-answer.png)')
  }
}

{
  const base = scenario('frame', 160, 50)
  const cfg = {
    ...base,
    sends: [
      { atTick: 30, data: '/console' },
      { atTick: 38, data: '\r' },
    ],
    total: 60,
  }
  const g = capture(cfg, '/tmp/grid-live-overlay.json')
  cleanupScenario('frame')
  if (g) {
    const text = g.grid.map(row => row.map(c => c.c ?? '').join('')).join('\n')
    check('the surface shell paints (Mercury — console)', text.includes('console'))
    check('empty state honest', text.includes('no asks yet'))
    check('ask line + footer advertise the armed keys', text.includes('↵ ask') && text.includes('esc close'))
    await gridToPng('/tmp/grid-live-overlay.json', '/tmp/live-console-overlay.png')
    console.log('  (png: /tmp/live-console-overlay.png)')
  }
}

console.log('')
if (failures > 0) {
  console.log(`❌ live-console-e2e: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ live-console-e2e: ALL GREEN (real ask answered on the surface)')
