#!/usr/bin/env bun
// ============================================================================
// scripts/ui/render-helm-runs.ts — render-verify for the cockpit RUNS lane
// active/running shells and monitors surface in
//  the cockpit view as first-class live rows.
//
//  Drives a REAL process end-to-end in the pyte PTY: a bang command
//  (`!sleep 300`) runs foreground, ctrl+b (task:background → backgroundAll)
//  backgrounds it — a genuine local_bash task, status 'running',
//  isBackgrounded=true — and the lanes rail must render:
//    · the `RUNS · 1 live` section header
//    · the command title (`sleep 300`)
//    · the `shell <elapsed>` kind+elapsed verb (formatSpan)
//    · a WORK glyph on the row (◐/◓/◑/◒ — WorkingGlyph frame; any frame is
//      valid, the PTY snapshot lands mid-rotation)
//  No mock: the same task store, tool path, and rail the operator sees.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-helm-runs.ts
//  Out:  /tmp/helm-runs-120.png + a PASS/FAIL summary (exit 1 on FAIL).
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { gridToPng } from './gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const NAME = 'cockpit-runs'
const VSHOT = join(import.meta.dir, 'vshot.py')

type Cell = { c: string }
type Grid = { grid: Cell[][] }

function capture(cols: number, scenarioName: string = NAME): Grid {
  const tag = scenarioName === NAME ? String(cols) : `${scenarioName}-${cols}`
  const gridPath = `/tmp/helm-runs-grid-${tag}.json`
  const cfg = { ...scenario(scenarioName, cols, 44), out: gridPath }
  const cfgPath = `/tmp/vshot-helm-runs-${tag}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_HELM_HOME: '1',
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
console.log(' Helm RUNS lane render-verify (real backgrounded shell @120)')
console.log('============================================================')

const g = capture(120)
const t = text(g)
void gridToPng('/tmp/helm-runs-grid-120.json', '/tmp/helm-runs-120.png').then(r =>
  console.log('  png:', r.path),
)

// The full chain ran: the bang shell was ctrl+b'd into the background
// (backgroundAll only has a target AFTER the ~2s registerForeground gate).
expect(
  'shell was genuinely backgrounded (the ctrl+b receipt in the transcript)',
  /manually backgrounded by user/.test(t),
)
// The lane exists and counts honestly (exactly one live process).
expect('RUNS section header present (`RUNS · 1 live`)', /RUNS · 1 live/.test(t))
// The row: WORK glyph (any WorkingGlyph frame) + the command title.
expect('run row carries a work glyph before the title', /[◐◓◑◒] sleep 300/.test(t))
// Kind + live elapsed verb (formatSpan: `Ns`/`Nm` at capture age).
expect('run row verb is `shell <elapsed>`', /sleep 300 · shell \d+[sm]/.test(t))
// The shell forces the BUSY branch (a running process is never "solo") —
// CREW renders (honest empty), and the solo NEXT hints are absent.
expect('busy branch: CREW lane present', /CREW ·/.test(t))
expect('solo NEXT hints replaced by the busy layout', !/NEXT/.test(t))
// TASKS (the mission board) no longer absorbs processes: with an empty
// ledger it reads plain `TASKS`, never `TASKS · N open`.
expect('TASKS header is ledger-only (no `· N open` conflation)', /TASKS(?! · \d+ open)/.test(t))

// --- the drill-through loop -----------------------
// Tab → ↓ → ↵ on the RUNS row opens THAT task's Mercury process card
// directly (`/tasks <id>`), and esc closes it back to the cockpit — the
// fork card's esc was a dead key until the real-PTY probe caught it.
console.log('\n▶ drill: ↵ on the RUNS row opens the process card')
const d = text(capture(120, 'cockpit-runs-drill'))
expect('the SPECIFIC process card opened (Mercury — shell header)', /Mercury — shell/.test(d))
expect('card state row is the live spine (`running · <t>`)', /running · \d+[sm]/.test(d))
expect('card carries the command', /command\s+sleep 300/.test(d))
expect('card footer advertises the REAL keys (esc/↵ close)', /esc\/↵ close/.test(d))
expect('the section rule stays INSIDE the card border (no │── overrun)', !/─│─/.test(d) && !/──│ /.test(d))

console.log('\n▶ drill-esc: esc closes the card back to the cockpit')
const e = text(capture(120, 'cockpit-runs-drill-esc'))
expect('esc dismissed the card (no shell header)', !/Mercury — shell/.test(e))
expect('back on the cockpit (RUNS lane present again)', /RUNS · 1 live/.test(e))

cleanupScenario(NAME)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
