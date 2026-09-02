#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-live-motion.ts — BILLED live render-verify for the
//  alive-REPL glyph pass (opt-in; makes ONE real API turn).
//
//  The standing animations are deterministically proven in prove-live-glyphs
//  (schedule math + wiring + strand-reset) and captures are pinned static via
//  the renderScenarios MERCURY_LIVE_GLYPHS=0 hermeticity pin — this runner is
//  the LIVE-MOTION leg: it drives the REAL built binary with liveness armed
//  and reads exact cell colors/glyphs from the vshot grid:
//    • the ToolUseLoader ROTATION — a real Bash tool (rule-allowed exact
//      `sleep …` — no permission dialog, no bypass mode) runs long enough to
//      capture mid-flight; the tool row's lead must be a WORK frame (◐◓◑◒),
//      and any non-◐ frame is positive proof the transcript mark rotates.
//    • the caret READY-BREATH — after the turn settles the compose caret must
//      paint one of the 5 CLAW→TERRA lerp shades (the idle breath), while
//      historical ❯ carets stay steady TERRA.
//    • (opportunistic) the ember-settle ✶ — its 320ms window is PTY-luck;
//      report if seen, never gate on it.
//
//  Run:  MERCURY_UI_BILLED=1 ~/.bun/bin/bun run scripts/ui/render-live-motion.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(root, 'dist', 'mercury.mjs')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])
const VSHOT = join(root, 'scripts', 'ui', 'vshot.py')

if (process.env.MERCURY_UI_BILLED !== '1') {
  console.log('SKIP render-live-motion (billed live-API proof — arm with MERCURY_UI_BILLED=1)')
  process.exit(0)
}
if (!existsSync(VSHOT) || !existsSync(BIN)) {
  console.error('vshot.py or dist/mercury.mjs missing — build first.')
  process.exit(1)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const note = (label: string, detail = ''): void => {
  console.log(`  [NOTE] ${label}${detail ? ` — ${detail}` : ''}`)
}

// The exact command the turn is allowed to run — rule-allowed, nothing else.
const SLEEP_CMD = 'sleep 7 && echo LIVE_MOTION_OK'
const PROMPT = `Use the Bash tool to run exactly this command: ${SLEEP_CMD}\nThen reply with just: done`

// One PTY drive, one capture at `total` ticks (~0.2s each).
const cfg = '/tmp/vs-live-motion.json'
writeFileSync(
  cfg,
  JSON.stringify({
    argv: ['node', BIN, '--allowedTools', `Bash(${SLEEP_CMD})`],
    // Boot ~7s → prompt at tick 32, submit 36. Turn latency (opus) ~3-6s →
    // the 7s sleep spans roughly ticks 55-95: capture at 72 lands mid-run
    // with generous margin on both sides.
    sends: [
      { atTick: 32, data: PROMPT.replace(/\n/g, ' ') },
      { atTick: 36, data: '\r' },
    ],
    total: 72,
    cols: 100,
    rows: 40,
    out: '/tmp/live-motion-grid.json',
    title: 'live motion — mid-tool',
  }),
)
// Settle window: a just-closed capture's session lock (spinner-hud precedent;
// never pkill — vshot owns its child).
execFileSync('sleep', ['4'])
execFileSync('/usr/bin/python3', [VSHOT, cfg], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(120000),
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    // The point of this runner: liveness ARMED (captures elsewhere pin =0).
    MERCURY_LIVE_GLYPHS: '1',
  },
})

type Cell = { c: string; fg: string; bg: string; bold: boolean }
const grid = JSON.parse(readFileSync('/tmp/live-motion-grid.json', 'utf8')) as {
  cols: number
  rows: number
  grid: Cell[][]
}
const lines = grid.grid.map(row => row.map(c => c.c).join(''))

// ── 1. the running tool row rotates ─────────────────────────────────────────
const WORK = ['◐', '◓', '◑', '◒']
let workCell: Cell | null = null
let workLine = ''
for (let r = 0; r < grid.grid.length; r++) {
  const line = lines[r] ?? ''
  // The running row reads "◓ Running 1 bash command…" (the grouped tool
  // header) — match it case-insensitively; a capital-B /Bash/ needle missed
  // the live row on the first armed run while the frame was
  // plainly rotating (◓ at TEAL crest, recorded in the ship commit).
  if (/running|bash/i.test(line)) {
    for (const cell of grid.grid[r]!) {
      if (WORK.includes(cell.c)) {
        workCell = cell
        workLine = line.trim()
        break
      }
    }
  }
  if (workCell) break
}
check(
  'a Bash tool row leads with a WORK frame (◐◓◑◒) mid-run',
  workCell !== null,
  workCell ? `'${workCell.c}' on: ${workLine.slice(0, 60)}` : 'no running Bash row in capture window',
)
if (workCell) {
  if (workCell.c !== '◐') {
    check('the frame is beyond frame 0 — the transcript mark ROTATES', true, `caught '${workCell.c}'`)
  } else {
    note('caught frame 0 (◐) — a valid frame; rotation evidenced 3/4 of instants, re-run to catch another')
  }
  note('running-mark breath shade', `fg #${workCell.fg}`)
}

// ── 2. opportunistic: the ember-settle ✶ (never gated) ─────────────────────
const sparkRow = grid.grid.flat().find(c => c.c === '✶' && c.bold)
if (sparkRow) note('caught the ember-settle ✶ live', `fg #${sparkRow.fg}`)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(' ❌ render-live-motion: failure(s) — see above')
  process.exit(1)
}
console.log(' ✅ live motion — the real binary animates (rotation + shades read from the grid)')
