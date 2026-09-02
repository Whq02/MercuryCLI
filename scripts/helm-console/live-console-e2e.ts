#!/usr/bin/env bun
// ============================================================================
//  scripts/helm-console/live-console-e2e.ts — the BILLED live E2E leg.
//  NOT gate-joined (real API usage; the operator-run live-script precedent).
//  Run explicitly:  ~/.bun/bin/bun run scripts/helm-console/live-console-e2e.ts
//
//  Leg 1 (billed): drive the REAL binary in a PTY — Tab ×2 → telemetry,
//  ↓-clamp onto the console input, type a question, ↵ — a REAL side-question
//  fork answers into the rail. Asserts the answer text + the receipt row
//  (duration · tokens · ↵ full) landed in the cell grid.
//  Leg 2 (unbilled): '/console' from the prompt — the overlay paints with its
//  command-center shell + empty-state + ask line.
// ============================================================================
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

// ── Leg 1: the billed rail ask ──
{
  const base = scenario('cockpit-console', 160, 50)
  const TAB = String.fromCharCode(9)
  const DOWN = String.fromCharCode(27) + '[B'
  const cfg = {
    ...base,
    sends: [
      { atTick: 30, data: TAB },
      { atTick: 34, data: TAB },
      { atTick: 38, data: DOWN.repeat(30) },
      { atTick: 44, data: 'Reply with exactly the single word: pong' },
      { atTick: 52, data: '\r' },
    ],
    // ↵ at ~10.4s; the fresh-session fallback rebuilds the full prefix, so
    // give the fork a generous window (~36s of post-↵ ticks).
    total: 235,
  }
  const g = capture(cfg, '/tmp/grid-live-console.json')
  cleanupScenario('cockpit-console')
  if (g) {
    const lines = g.grid.map(row => row.map(c => c.c ?? '').join(''))
    const text = lines.join('\n')
    check('question echoed in the console section', text.includes('Reply with exactly'))
    check('REAL answer landed in the rail', /\bpong\b/i.test(text))
    check('receipt row painted (duration · tokens · ↵ full)', text.includes('↵ full'))
    const receiptLine = lines.find(l => l.includes('↵ full')) ?? ''
    check('receipt carries a token count', /\d(\.\d)?[km]?→/.test(receiptLine), receiptLine.trim().slice(0, 40))
    await gridToPng('/tmp/grid-live-console.json', '/tmp/live-console-answer.png')
    console.log('  (png: /tmp/live-console-answer.png)')
  }
}

// ── Leg 2: the /console overlay (unbilled) ──
{
  const base = scenario('cockpit-console', 160, 50)
  const cfg = {
    ...base,
    sends: [
      { atTick: 30, data: '/console' },
      { atTick: 38, data: '\r' },
    ],
    total: 60,
  }
  const g = capture(cfg, '/tmp/grid-live-overlay.json')
  cleanupScenario('cockpit-console')
  if (g) {
    const text = g.grid.map(row => row.map(c => c.c ?? '').join('')).join('\n')
    check('overlay shell paints (Mercury — console)', text.includes('console'))
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
console.log('✅ live-console-e2e: ALL GREEN (real ask answered in the rail)')
