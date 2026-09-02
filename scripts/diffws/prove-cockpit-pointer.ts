#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASH_RAISED } from '../../src/components/mercuryPalette.ts'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Cell = { c: string; bg?: string }
const HOVER_BG = ASH_RAISED.slice(1).toLowerCase()
const COLS = 168
const ROWS = 45
const RAIL_FROM = Math.floor(COLS * 0.75)

function capture(
  tag: string,
  sends: Array<{ atTick: number; data: string }>,
  total: number,
): { lines: string[]; grid: Cell[][] } | null {
  const cfg = scenario('companion-cockpit', COLS, ROWS)
  cfg.sends = sends
  cfg.total = total
  const gridPath = `/tmp/cockpit-ptr-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/cockpit-ptr-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  cleanupScenario('companion-cockpit')
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
  return { lines: grid.map(r => r.map(c => c.c).join('')), grid }
}

const motion = (x: number, y: number): string => `\x1b[<35;${x};${y}M`
const click = (x: number, y: number): string => `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`

type Anchors = { ctxRow: number; ctxCol: number; wfHdrRow: number; wfHdrCol: number; usageHdrRow: number }
function deriveAnchors(lines: string[]): Anchors | null {
  const ctxRow = lines.findIndex(l => l.slice(RAIL_FROM).includes('ctx '))
  const wfHdrRow = lines.findIndex(l => l.slice(RAIL_FROM).includes('WORKFLOW'))
  const usageHdrRow = lines.findIndex(l => l.slice(RAIL_FROM).includes('USAGE'))
  if (ctxRow < 0 || wfHdrRow < 0 || usageHdrRow < 0) return null
  return {
    ctxRow,
    ctxCol: RAIL_FROM + lines[ctxRow]!.slice(RAIL_FROM).indexOf('ctx '),
    wfHdrRow,
    wfHdrCol: RAIL_FROM + lines[wfHdrRow]!.slice(RAIL_FROM).indexOf('WORKFLOW'),
    usageHdrRow,
  }
}

function leg(
  tag: string,
  build: (a: Anchors) => Array<{ atTick: number; data: string }>,
  total: number,
  assert: (r: { lines: string[]; grid: Cell[][] }, a: Anchors) => boolean,
  label: string,
  detail?: (r: { lines: string[]; grid: Cell[][] }) => string,
): void {
  const SETTLE = 40
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = capture(`${tag}-base${attempt}`, [], 52 + SETTLE)
    const a = base ? deriveAnchors(base.lines) : null
    if (!a) continue
    const sends = build(a).map(s => ({ ...s, atTick: s.atTick + SETTLE }))
    const r = capture(`${tag}-${attempt}`, sends, total + SETTLE)
    if (!r) continue
    if (assert(r, a) || attempt === 2) {
      check(label, assert(r, a), assert(r, a) ? '' : (detail?.(r) ?? ''))
      return
    }
  }
  check(label, false, 'anchors unavailable')
}

console.log('============================================================')
console.log(' cockpit pointer — hover · select · activate · draft-safe')
console.log('============================================================')

console.log('\n── warm-up + baseline sanity ────────────────────────────────')
capture('warm', [], 52)
{
  const base = capture('sanity', [], 52)
  const a = base ? deriveAnchors(base.lines) : null
  check('telemetry anchors present (ctx row + WORKFLOW header)', !!a, a ? `ctx=${a.ctxRow} wf=${a.wfHdrRow}` : '')
  if (base) check('rail is unfocused at rest (no ❯ telemetry banner)', !base.lines.some(l => l.includes('❯ telemetry')))
}

console.log('\n── A. hover paints exactly one telemetry row ────────────────')
leg(
  'hover',
  a => [{ atTick: 44, data: motion(a.ctxCol + 1, a.ctxRow + 1) }],
  56,
  (r, a) => {
    const lit: number[] = []
    r.grid.forEach((row, y) => {
      if (row.slice(RAIL_FROM).some(c => c.bg?.toLowerCase() === HOVER_BG)) lit.push(y)
    })
    return lit.length === 1 && lit[0] === a.ctxRow
  },
  'hover paints exactly the pointed telemetry row',
)

console.log('\n── B. first click SELECTS (focus + cursor), never activates ─')
leg(
  'select',
  a => [{ atTick: 44, data: click(a.ctxCol + 1, a.ctxRow + 1) }],
  58,
  (r, a) => {
    const focusBanner = r.lines.some(l => l.includes('❯ telemetry'))
    const cursorInPanel = r.lines.some((l, y) => {
      if (y <= a.usageHdrRow || y >= a.wfHdrRow + 2) return false
      return l.slice(RAIL_FROM - 2).includes('❯')
    })
    const noSurface = !r.lines.some(l => l.includes('— deck'))
    return focusBanner && cursorInPanel && noSurface
  },
  'first click focuses the rail + moves ❯ into the pointed panel (no activation)',
  r => r.lines.filter(l => l.slice(RAIL_FROM).trim()).slice(0, 3).map(l => l.slice(RAIL_FROM)).join(' | '),
)

console.log('\n── C. second click ACTIVATES the owning surface ─────────────')
leg(
  'activate',
  a => [
    { atTick: 44, data: click(a.ctxCol + 1, a.ctxRow + 1) },
    { atTick: 52, data: click(a.ctxCol + 1, a.ctxRow + 1) },
  ],
  74,
  r =>
    r.lines.some(
      l =>
        l.includes('— cockpit') ||
        l.includes('— deck') ||
        (l.includes('Deck') && l.includes('Fleet') && l.includes('Trace')) ||
        (l.includes('Status') && l.includes('Config') && l.includes('Usage')),
    ),
  'second click on the selected row opens its surface (/deck — same as ↵)',
  r => r.lines.filter(l => l.trim()).slice(0, 2).join(' | '),
)

console.log('\n── D. panel HEADER: one click opens /workflows ──────────────')
leg(
  'header',
  a => [{ atTick: 44, data: click(a.wfHdrCol + 1, a.wfHdrRow + 1) }],
  74,
  r => r.lines.some(l => l.includes('— workflows')),
  'one click on the WORKFLOW header opens the /workflows board',
  r => r.lines.filter(l => l.trim()).slice(0, 2).join(' | '),
)

console.log('\n── E. a typed draft survives pointer open + esc back ────────')
leg(
  'draft',
  a => [
    { atTick: 40, data: 'draft survives' },
    { atTick: 48, data: click(a.wfHdrCol + 1, a.wfHdrRow + 1) },
    { atTick: 62, data: '\x1b' },
  ],
  80,
  r => r.lines.some(l => l.includes('draft survives')),
  'the typed draft is intact after pointer open + esc back',
)

console.log()
if (failures > 0) {
  console.log(`❌ COCKPIT-POINTER PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ COCKPIT-POINTER PROOF PASS')
