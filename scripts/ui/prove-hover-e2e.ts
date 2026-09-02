#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASH_RAISED, IVORY, OASIS } from '../../src/components/mercuryPalette.ts'
import { lerpHex } from '../../src/utils/theme.ts'
import { railPlanAt } from '../../src/utils/helmGeometry.ts'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Cell = { c: string; bg?: string }
type Grid = { grid: Cell[][] }
const HOVER_BG = ASH_RAISED.slice(1).toLowerCase()
const RAIL_COLS = 32

type Region = [number, number, number, number]
type Send = {
  atTick?: number
  data: string
  awaitText?: string
  awaitRaw?: string
  minTick?: number
  awaitSettleTicks?: number
  awaitStableTicks?: number
  awaitStableRegion?: Region
  afterPrevTicks?: number
  requireAwait?: boolean
  targetText?: string
  targetDx?: number
}

const MOUSE_ARM_GATE: Send = { data: '', awaitRaw: '\x1b[?1003h', requireAwait: true }

function capture(
  tag: string,
  sends: Send[],
  total: number,
  readyText?: string | string[],
  cols = 120,
  rows = 40,
  settled?: { stableTicks: number; region?: Region },
): { lines: string[]; grid: Cell[][] } | null {
  const cfg = scenario('companion-cockpit', cols, rows)
  cfg.sends = sends
  cfg.total = total
  if (readyText) {
    cfg.readyText = readyText
    cfg.readySettleTicks = 3
  }
  if (settled) {
    Object.assign(cfg, {
      stableTicks: settled.stableTicks,
      requireStable: true,
      ...(settled.region ? { stableRegion: settled.region } : {}),
    })
  }
  const gridPath = `/tmp/hover-e2e-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/hover-e2e-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
      MERCURY_OPERATOR: 'op',
      MERCURY_CHANNEL_ROOM: `hover-${tag}-${process.pid}`,
    },
  })
  cleanupScenario('companion-cockpit')
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  return { lines: grid.map(r => r.map(c => c.c).join('')), grid }
}

const motionT = '\x1b[<35;{X};{Y}M'
const pressT = '\x1b[<0;{X};{Y}M'
const releaseT = '\x1b[<0;{X};{Y}m'
const dragT = '\x1b[<32;{X};{Y}M'

function hoverRows(grid: Cell[][]): number[] {
  const rows: number[] = []
  grid.forEach((row, y) => {
    if (row.slice(0, RAIL_COLS).some(c => c.bg?.toLowerCase() === HOVER_BG)) rows.push(y)
  })
  return rows
}

console.log('============================================================')
console.log(' hover E2E — one highlight on sweep, none mid-drag')
console.log('============================================================')

console.log('\n── baseline: anchor two hover-armed rail rows ──────────────')
const base = capture('base', [], 90, ['op (you)', 'ask minerva'], 120, 40, {
  stableTicks: 8,
  region: [0, 0, RAIL_COLS, 40],
})
let rowA = -1
let rowB = -1
if (base) {
  rowA = base.lines.findIndex(l => l.includes('op (you)'))
  rowB = base.lines.findIndex(l => l.includes('ask minerva'))
  check('both anchor rows present', rowA >= 0 && rowB >= 0, `A=${rowA} B=${rowB}`)
  if (rowA < 0 || rowB < 0) {
    console.log('  … rail rows 0-16 (first 40 cols):')
    base.lines.slice(0, 17).forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 40)}`))
  }
  check('baseline carries no hover fill', hoverRows(base.grid).length === 0)
}

if (rowA >= 0 && rowB >= 0) {
  console.log('\n── A. sweep: A then B ⇒ exactly ONE lit row (B) ────────────')
  const sweepSends: Send[] = [
    MOUSE_ARM_GATE,
    {
      data: motionT,
      targetText: 'op (you)',
      targetDx: 1,
      awaitText: 'ask minerva',
      minTick: 8,
      awaitSettleTicks: 8,
      awaitStableTicks: 8,
      awaitStableRegion: [0, 0, RAIL_COLS, 40],
      requireAwait: true,
    },
    { data: motionT, targetText: 'ask minerva', targetDx: 2, afterPrevTicks: 6 },
  ]
  const sweep = capture('sweep', sweepSends, 150, undefined, 120, 40, { stableTicks: 8, region: [0, 0, RAIL_COLS, 40] })
  if (sweep) {
    const lit = hoverRows(sweep.grid)
    check('exactly ONE left-rail row wears the hover fill', lit.length === 1, `lit=${lit.join(',') || 'none'}`)
    check(
      "the lit row is B (the pointer's current target)",
      lit.length === 1 && (sweep.lines[lit[0]!] ?? '').includes('ask minerva'),
      lit.length === 1 ? `lit row: ${sweep.lines[lit[0]!]?.slice(0, 40)}` : '',
    )
    check(
      'row A carries no stranded highlight',
      !lit.some(y => (sweep.lines[y] ?? '').includes('op (you)')),
    )
    if (lit.length !== 1 || !(sweep.lines[lit[0]!] ?? '').includes('ask minerva')) {
      console.log('  … rail rows 0-16 (first 40 cols) at capture end:')
      sweep.lines.slice(0, 17).forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 40)}`))
    }
  }

  console.log('\n── B. drag: press then move ⇒ ZERO hover fills ─────────────')
  const dragged = capture(
    'drag',
    [
      MOUSE_ARM_GATE,
      {
        data: motionT,
        targetText: 'op (you)',
        targetDx: 1,
        awaitText: 'ask minerva',
        minTick: 8,
        awaitSettleTicks: 8,
        awaitStableTicks: 8,
        awaitStableRegion: [0, 0, RAIL_COLS, 40],
        requireAwait: true,
      },
      { data: pressT, targetText: 'op (you)', targetDx: 1, afterPrevTicks: 4 },
      { data: dragT, targetText: 'ask minerva', targetDx: 2, afterPrevTicks: 4 },
    ],
    152,
  )
  if (dragged) {
    const lit = hoverRows(dragged.grid)
    check('zero hover fills while the button is down', lit.length === 0, `lit=${lit.join(',')}`)
  }
}

{
  console.log('\n── C. chrome header hover: ink only, click opens, draft survives ──')
  const W = 160
  const H = 50
  const RIGHT_START = W - railPlanAt(W, true).telemetryW
  const REST_FG = OASIS.slice(1).toLowerCase()
  const HOVER_FG = lerpHex(OASIS, IVORY, 0.4).slice(1).toLowerCase()
  const rightBandFills = (grid: Cell[][]): number[] => {
    const rows: number[] = []
    grid.forEach((row, y) => {
      if (row.slice(RIGHT_START).some(c => c.bg?.toLowerCase() === HOVER_BG)) rows.push(y)
    })
    return rows
  }
  const labelFg = (grid: Cell[][], y: number, x0: number): string[] =>
    (grid[y] ?? []).slice(x0, x0 + 8).map(c => (c as Cell & { fg?: string }).fg?.toLowerCase() ?? '')

  const hdrBase = capture('hdr-base', [], 90, 'WORKFLOW', W, H, {
    stableTicks: 8,
    region: [RIGHT_START, 0, W, H],
  })
  let hx = -1
  let hy = -1
  if (hdrBase) {
    hy = hdrBase.lines.findIndex(l => l.includes('WORKFLOW'))
    hx = hy >= 0 ? hdrBase.lines[hy]!.indexOf('WORKFLOW') : -1
    check('the WORKFLOW header is present at 160×50', hy >= 0 && hx >= RIGHT_START, `row=${hy} col=${hx}`)
    check('rest: zero fill cells in the right-rail band', rightBandFills(hdrBase.grid).length === 0)
    check(
      'rest: the label wears the info hue',
      labelFg(hdrBase.grid, hy, hx).every(f => f === REST_FG),
      labelFg(hdrBase.grid, hy, hx).join(','),
    )
  }
  if (hy >= 0 && hx >= 0) {
    const hoverSends: Send[] = [
      MOUSE_ARM_GATE,
      {
        data: 'glidedraft',
        awaitText: 'WORKFLOW',
        minTick: 8,
        awaitSettleTicks: 8,
        awaitStableTicks: 8,
        awaitStableRegion: [RIGHT_START, 0, W, H],
        requireAwait: true,
      },
      { data: motionT, targetText: 'WORKFLOW', targetDx: 2, awaitText: 'glidedraft', minTick: 8, awaitSettleTicks: 2, requireAwait: true },
    ]
    const hovered = capture('hdr-hover', hoverSends, 130, undefined, W, H, { stableTicks: 8, region: [RIGHT_START, 0, W, H] })
    if (hovered) {
      const y2 = hovered.lines.findIndex(l => l.includes('WORKFLOW'))
      const x2 = y2 >= 0 ? hovered.lines[y2]!.indexOf('WORKFLOW') : -1
      check('hover: ZERO fill cells in the right-rail band', rightBandFills(hovered.grid).length === 0, `rows=${rightBandFills(hovered.grid).join(',')}`)
      check(
        'hover: the label brightened to infoShimmer',
        y2 >= 0 && labelFg(hovered.grid, y2, x2).every(f => f === HOVER_FG),
        y2 >= 0 ? labelFg(hovered.grid, y2, x2).join(',') : 'header missing',
      )
      check('hover: the draft is intact in the composer', hovered.lines.some(l => l.includes('glidedraft')))
    }
    const openSends: Send[] = [
      ...hoverSends,
      { data: pressT, targetText: 'WORKFLOW', targetDx: 2, afterPrevTicks: 6 },
      { data: releaseT, targetText: 'WORKFLOW', targetDx: 2, afterPrevTicks: 2 },
    ]
    const opened = capture('hdr-open', openSends, 150, undefined, W, H, { stableTicks: 8, region: [RIGHT_START, 0, W, H] })
    if (opened) {
      check('click: ONE click opened the workflows surface', opened.lines.some(l => l.includes('No workflow runs')))
    }
    const escSends: Send[] = [
      ...openSends,
      { data: '\x1b', awaitText: 'No workflow runs', minTick: 4, awaitSettleTicks: 6, requireAwait: true },
    ]
    const escd = capture('hdr-esc', escSends, 170, undefined, W, H, { stableTicks: 8, region: [RIGHT_START, 0, W, H] })
    if (escd) {
      check('esc: back from the board (its content is gone)', !escd.lines.some(l => l.includes('No workflow runs')))
      check('esc: the draft survived the round trip', escd.lines.some(l => l.includes('glidedraft')))
    }
  }
}

{
  console.log('\n── D. left lane title: SEAT glance is display-only (no hover ink, no click door) ──')
  const W = 160
  const H = 50
  const LANES_W = railPlanAt(W, true).lanesW
  const REST_FG = OASIS.slice(1).toLowerCase()
  const HOVER_FG = lerpHex(OASIS, IVORY, 0.4).slice(1).toLowerCase()
  const leftBandFills = (grid: Cell[][]): number[] => {
    const rows: number[] = []
    grid.forEach((row, y) => {
      if (row.slice(0, LANES_W).some(c => c.bg?.toLowerCase() === HOVER_BG)) rows.push(y)
    })
    return rows
  }
  const seatFg = (grid: Cell[][], y: number, x0: number): string[] =>
    (grid[y] ?? []).slice(x0, x0 + 4).map(c => (c as Cell & { fg?: string }).fg?.toLowerCase() ?? '')

  const base = capture('seat-base', [], 90, 'SEAT', W, H, {
    stableTicks: 8,
    region: [0, 0, LANES_W, H],
  })
  let sx = -1
  let sy = -1
  if (base) {
    sy = base.lines.findIndex(l => l.includes('SEAT'))
    sx = sy >= 0 ? base.lines[sy]!.indexOf('SEAT') : -1
    check('the SEAT lane header is present at 160×50', sy >= 0 && sx >= 0 && sx < LANES_W, `row=${sy} col=${sx}`)
    check('rest: zero fill cells in the left lanes band', leftBandFills(base.grid).length === 0)
    check(
      'rest: the SEAT label wears the info hue',
      sy >= 0 && seatFg(base.grid, sy, sx).every(f => f === REST_FG),
      sy >= 0 ? seatFg(base.grid, sy, sx).join(',') : 'missing',
    )
  }
  if (sy >= 0 && sx >= 0) {
    const hoverSends: Send[] = [
      MOUSE_ARM_GATE,
      {
        data: motionT,
        targetText: 'SEAT',
        targetDx: 1,
        awaitText: 'SEAT',
        minTick: 8,
        awaitSettleTicks: 8,
        awaitStableTicks: 8,
        awaitStableRegion: [0, 0, LANES_W, H],
        requireAwait: true,
      },
    ]
    const hovered = capture('seat-hover', hoverSends, 120, undefined, W, H, { stableTicks: 8, region: [0, 0, LANES_W, H] })
    if (hovered) {
      const y2 = hovered.lines.findIndex(l => l.includes('SEAT'))
      const x2 = y2 >= 0 ? hovered.lines[y2]!.indexOf('SEAT') : -1
      check('hover: ZERO fill cells in the left lanes band', leftBandFills(hovered.grid).length === 0, `rows=${leftBandFills(hovered.grid).join(',')}`)
      check(
        'hover: the SEAT label stays the REST info hue (display-only — no shimmer without an action)',
        y2 >= 0 && seatFg(hovered.grid, y2, x2).every(f => f === REST_FG),
        y2 >= 0 ? seatFg(hovered.grid, y2, x2).join(',') : 'header missing',
      )
      check(
        'hover poison: the infoShimmer hue never paints the SEAT label',
        y2 >= 0 && !seatFg(hovered.grid, y2, x2).some(f => f === HOVER_FG),
        y2 >= 0 ? seatFg(hovered.grid, y2, x2).join(',') : 'header missing',
      )
    }
    const openSends: Send[] = [
      ...hoverSends,
      { data: pressT, targetText: 'SEAT', targetDx: 1, afterPrevTicks: 6 },
      { data: releaseT, targetText: 'SEAT', targetDx: 1, afterPrevTicks: 2 },
    ]
    const opened = capture('seat-open', openSends, 150, undefined, W, H, { stableTicks: 8, region: [0, 0, LANES_W, H] })
    if (opened) {
      const y3 = opened.lines.findIndex(l => l.includes('SEAT'))
      check(
        'click: NOTHING opens — the rail still stands with its SEAT header (the click is inert)',
        y3 >= 0 && leftBandFills(opened.grid).length === 0,
        `row=${y3} fills=${leftBandFills(opened.grid).join(',')}`,
      )
      check(
        'click poison: the retired board title can never paint',
        !opened.lines.some(l => l.includes('Mercury — multiplayer')),
      )
    }
  }
}

console.log()
if (failures > 0) {
  console.log(`❌ HOVER-E2E PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ HOVER-E2E PROOF PASS')
