#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ptyDriverPython, vshotBudgetMs } from '../lib/captureDriver.ts'
import { cleanupScenario, scenario } from '../ui/renderScenarios.ts'

const RIG = join(import.meta.dir, 'lib', 'screenrig.py')
const COLS = 120
const ROWS = 44
const ESC = '\u001b'
const FOCUS_OUT = `${ESC}[O`
const FOCUS_IN = `${ESC}[I`
const REDRAW = '\u000c'

type Row = { cells: string[]; attrs: Array<[number, string]> }
type Flash = { bytes: number; eraseDisplay: number; eraseBelow: number; altSwitch: number; maxLost: number; lostAt: string | null }
type Snap = { name: string; grid: Row[]; flash: Flash; raw: string }
type Step = Record<string, unknown>

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

function cellsOf(snap: Snap): string[] {
  const out: string[] = []
  for (const row of snap.grid) {
    let x = 0
    for (const [count, attrs] of row.attrs) {
      for (let i = 0; i < count; i++, x++) out.push(`${row.cells[x]}\u0000${attrs}`)
    }
  }
  return out
}

function differing(a: Snap, b: Snap): string {
  const left = cellsOf(a)
  const right = cellsOf(b)
  let cells = 0
  const rows = new Set<number>()
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    cells++
    rows.add(Math.floor(i / COLS))
  }
  return cells === 0 ? '' : `${cells} of ${Math.max(left.length, right.length)} cells differ on ${rows.size} rows`
}

const inked = (snap: Snap): number => snap.grid.reduce((n, row) => n + row.cells.filter(cell => cell !== ' ' && cell !== '').length, 0)

function drive(label: string, steps: Step[], env: Record<string, string | undefined>): Map<string, Snap> {
  const cfg = scenario('resume-2turn', COLS, ROWS)
  const dir = mkdtempSync(join(tmpdir(), 'screen-loss-'))
  const out = join(dir, 'out.json')
  const cfgPath = join(dir, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, cols: COLS, rows: ROWS, steps, out }))
  const childEnv: Record<string, string | undefined> = { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', ...env }
  for (const name of Object.keys(childEnv)) if (childEnv[name] === undefined) delete childEnv[name]
  const run = spawnSync(ptyDriverPython('the screen-loss proof'), [RIG, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env: childEnv as NodeJS.ProcessEnv })
  const snaps = new Map<string, Snap>()
  try {
    check(`${label}: the rig ran its script to the end`, run.status === 0, (run.stderr ?? '').slice(-400))
    if (run.status === 0) {
      const parsed = JSON.parse(readFileSync(out, 'utf8')) as { snaps: Snap[] }
      for (const snap of parsed.snaps) snaps.set(snap.name, snap)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return snaps
}

const settle = { op: 'settle', quietMs: 1200, maxMs: 10000 }
const focusAwayAndBack: Step[] = [{ op: 'send', data: FOCUS_OUT }, { op: 'sleep', ms: 300 }, { op: 'send', data: FOCUS_IN }, settle]
const script: Step[] = [
  { op: 'await', text: 'second task', maxMs: 40000 },
  { op: 'await', text: 'ctx ≈', maxMs: 40000 },
  { op: 'settle', quietMs: 2000, maxMs: 20000 },
  { op: 'snap', name: 'painted' },
  ...focusAwayAndBack,
  { op: 'snap', name: 'focus on a whole screen' },
  { op: 'scribble' },
  ...focusAwayAndBack,
  { op: 'snap', name: 'focus after the screen was lost' },
  { op: 'scribble' },
  { op: 'signal', name: 'SIGWINCH' },
  settle,
  { op: 'snap', name: 'a same-size SIGWINCH after the screen was lost' },
  { op: 'scribble' },
  { op: 'send', data: REDRAW },
  settle,
  { op: 'snap', name: 'the redraw key after the screen was lost' },
  { op: 'resize', cols: COLS - 6, rows: ROWS - 3 },
  { op: 'sleep', ms: 50 },
  { op: 'resize', cols: COLS - 14, rows: ROWS - 6 },
  settle,
  { op: 'snap', name: 'a resize storm settled' },
  { op: 'resize', cols: COLS, rows: ROWS },
  settle,
  { op: 'snap', name: 'the first size again' },
]

function read(label: string, snaps: Map<string, Snap>): void {
  const painted = snaps.get('painted')
  if (painted === undefined) {
    check(`${label}: the cockpit painted`, false, 'no snapshot')
    return
  }
  check(`${label}: the cockpit painted the resumed transcript`, inked(painted) > 800 && painted.grid.some(row => row.cells.join('').includes('second task')), `${inked(painted)} inked cells`)
  const whole = snaps.get('focus on a whole screen')
  check(`${label}: focus out and in on a whole screen changes no cell`, whole !== undefined && differing(whole, painted) === '', whole ? differing(whole, painted) : 'no snapshot')
  check(`${label}: and blanks none on the way: no cell inked before and after is ever blank, no erase of the display`, whole !== undefined && whole.flash.maxLost === 0 && whole.flash.eraseDisplay === 0 && whole.flash.eraseBelow === 0 && whole.flash.altSwitch === 0, JSON.stringify(whole?.flash))
  for (const name of ['focus after the screen was lost', 'a same-size SIGWINCH after the screen was lost', 'the redraw key after the screen was lost']) {
    const snap = snaps.get(name)
    check(`${label}: ${name}, every cell equals the painted frame`, snap !== undefined && differing(snap, painted) === '', snap ? differing(snap, painted) : 'no snapshot')
    check(`${label}: ${name}, repaired by overwriting (no erase of the display, whole or below)`, snap !== undefined && snap.flash.eraseDisplay === 0 && snap.flash.eraseBelow === 0 && snap.flash.altSwitch === 0, JSON.stringify(snap?.flash))
  }
  const storm = snaps.get('a resize storm settled')
  check(`${label}: a resize storm settles without an erase of the whole display`, storm !== undefined && storm.flash.eraseDisplay === 0 && inked(storm) > 500, JSON.stringify(storm?.flash))
  const back = snaps.get('the first size again')
  check(`${label}: back at the first size every cell equals the painted frame`, back !== undefined && differing(back, painted) === '', back ? differing(back, painted) : 'no snapshot')
  check(`${label}: and that settle erased no row the frame had painted (the hold erases below the old frame only)`, back !== undefined && back.flash.eraseDisplay === 0, JSON.stringify(back?.flash))
}

try {
  section('1. a terminal with 24-bit colour and no synchronized output (every cell carries the ground)')
  read('colour', drive('colour', script, { COLORTERM: 'truecolor', NO_COLOR: undefined, FORCE_COLOR: undefined }))
  section('2. the same terminal without colour (blank cells carry nothing)')
  read('plain', drive('plain', script, { NO_COLOR: '1', FORCE_COLOR: undefined, COLORTERM: undefined }))
} finally {
  cleanupScenario('resume-2turn')
}

console.log(`\nscreen-loss-repaints: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
