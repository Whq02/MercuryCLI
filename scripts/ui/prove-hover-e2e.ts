#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
const RAIL_COLS = railPlanAt(120, true).lanesW
const WORKBENCH_ROW = '  second task —'
const FILES_ROW = 'or click · browse'

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
  const cfg = scenario('cockpit-short', cols, rows)
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
  const gridPath = join(tmpdir(), `hover-e2e-${tag}-${process.pid}.json`)
  const cfgPath = join(tmpdir(), `hover-e2e-${tag}-cfg-${process.pid}.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  cleanupScenario('cockpit-short')
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
const base = capture('base', [], 90, [FILES_ROW, WORKBENCH_ROW], 120, 40, {
  stableTicks: 8,
  region: [0, 0, RAIL_COLS, 40],
})
let rowA = -1
let rowB = -1
if (base) {
  rowA = base.lines.findIndex(l => l.slice(0, RAIL_COLS).includes(FILES_ROW))
  rowB = base.lines.findIndex(l => l.slice(0, RAIL_COLS).includes(WORKBENCH_ROW))
  check('both anchor rows present', rowA >= 0 && rowB >= 0, `A=${rowA} B=${rowB}`)
  if (rowA < 0 || rowB < 0) {
    console.log('  … rail rows 0-16 (first 40 cols):')
    base.lines.slice(0, 17).forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 40)}`))
  }
  check('baseline carries no hover fill', hoverRows(base.grid).length === 0)
  check('the rail paints no SEAT box (the retired presence estate)', !base.lines.some(l => /SEAT ·|\(you\)/.test(l.slice(0, RAIL_COLS))))
}

if (rowA >= 0 && rowB >= 0) {
  console.log('\n── A. sweep: A then B ⇒ exactly ONE lit row (B) ────────────')
  const sweepSends: Send[] = [
    MOUSE_ARM_GATE,
    {
      data: motionT,
      targetText: FILES_ROW,
      targetDx: 1,
      awaitText: WORKBENCH_ROW,
      minTick: 8,
      awaitSettleTicks: 8,
      awaitStableTicks: 8,
      awaitStableRegion: [0, 0, RAIL_COLS, 40],
      requireAwait: true,
    },
    { data: motionT, targetText: WORKBENCH_ROW, targetDx: 2, afterPrevTicks: 6 },
  ]
  const sweep = capture('sweep', sweepSends, 150, undefined, 120, 40, { stableTicks: 8, region: [0, 0, RAIL_COLS, 40] })
  if (sweep) {
    const lit = hoverRows(sweep.grid)
    const startB = sweep.lines.findIndex(l => l.slice(0, RAIL_COLS).includes(WORKBENCH_ROW))
    let endB = startB
    while (startB >= 0 && endB + 1 < sweep.lines.length && /^ {2}\S/.test((sweep.lines[endB + 1] ?? '').slice(0, RAIL_COLS))) endB++
    const cardRows = startB >= 0 ? Array.from({ length: endB - startB + 1 }, (_, i) => startB + i) : []
    const contiguous = lit.length > 0 && lit.every((y, i) => i === 0 || y === lit[i - 1]! + 1)
    const wholeCard = startB >= 0 && lit.length === cardRows.length && lit.every((y, i) => y === cardRows[i])
    check('exactly ONE hover-armed item wears the hover fill: one contiguous block of rail rows', contiguous, `lit=${lit.join(',') || 'none'}`)
    check(
      "the lit block is B (the pointer's current target): the WORKBENCH card's wrapped rows, whole, and no other row",
      wholeCard,
      `lit=${lit.join(',') || 'none'} card=${cardRows.join(',') || 'none'}${startB >= 0 ? ` first: ${sweep.lines[startB]?.slice(0, 40)}` : ''}`,
    )
    check(
      'row A carries no stranded highlight',
      !lit.some(y => (sweep.lines[y] ?? '').slice(0, RAIL_COLS).includes(FILES_ROW)),
    )
    if (!contiguous || !wholeCard) {
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
        targetText: FILES_ROW,
        targetDx: 1,
        awaitText: WORKBENCH_ROW,
        minTick: 8,
        awaitSettleTicks: 8,
        awaitStableTicks: 8,
        awaitStableRegion: [0, 0, RAIL_COLS, 40],
        requireAwait: true,
      },
      { data: pressT, targetText: FILES_ROW, targetDx: 1, afterPrevTicks: 4 },
      { data: dragT, targetText: WORKBENCH_ROW, targetDx: 2, afterPrevTicks: 4 },
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

console.log()
if (failures > 0) {
  console.log(`❌ HOVER-E2E PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ HOVER-E2E PROOF PASS')
