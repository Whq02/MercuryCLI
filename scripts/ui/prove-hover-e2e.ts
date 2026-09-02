#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-hover-e2e.ts — the chain-highlight bug, refuted in the
//  REAL binary (operator screenshot: multiple rail rows lit at
//  once across different cards; rows lit while the button was down).
//
//  Drives the cockpit in a PTY with injected SGR mouse bytes (the
//  prove-click-expand idiom — zero API cost):
//    A. SWEEP: motion onto row A, then row B — exactly ONE left-rail row may
//       wear the ASH_RAISED hover fill, and it is row B (row A's highlight
//       was displaced even though its leave event may never have fired).
//    B. DRAG: motion A → press A → drag to B — ZERO hover fills anywhere
//       (press clears, drag suppresses; the drag's text-selection wash is
//       DUNE, a different token, deliberately not counted).
//  Coordinates are resolved IN-BOOT at fire time (vshot `targetText` — the
//  baseline boot only proves the anchors exist; indices never cross boots).
// ============================================================================
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
// The left rail spans the first ~30 cols at 120 wide — the assertion region
// (the right rail's own wells stay out of scope).
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

/** The pointer-input ARM gate (settled-phase law): the app declares mouse
 *  tracking by emitting DECSET 1003 (any-motion) — a motion sent before that
 *  arming lands in an unarmed parser and vanishes ("paint ≠ input-wired").
 *  Strict: if the app never arms, the capture refuses loudly (exit 4). */
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
    // Anchor captures must observe a layout that has STOPPED MOVING (async
    // rail sections — the RECENT scan placeholder, the TABULA fold — land
    // after first paint and shift every row below them); a never-settling
    // grid is refused (exit 5), never silently anchored. Stability is
    // scoped to the band the coordinates live in: the cockpit's far-right
    // session clock ticks forever and must not veto the rail's settle.
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
      // PINNED seat name (F6): the seat row truncates a long login out of
      // its ' (you)' suffix (CI's 'runner' → 'runner (y…'); a short neutral
      // pin renders '● op (you)' identically on every machine.
      // CANONICAL spelling: the pin block inherits MERCURY_OPERATOR='sam'
      // into every scenario env — only the same key overrides it.
      MERCURY_OPERATOR: 'op',
      // PINNED presence room (F6, round 13): the default room is CWD-derived,
      // so every capture in a suite shares ~/.claude/channels/<room>/presence —
      // on CI the PREVIOUS capture's snapshot is still heartbeat-fresh and
      // lands as an async PEER row above TABULA, shifting the anchored target
      // one row after the hover already latched. A unique room per capture
      // keeps the presence dir empty and the SEAT section single-row forever.
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

/** SGR sequences with {X}/{Y} placeholders — vshot resolves them from the
 *  send's `targetText` against the LIVE grid at fire time (the cross-boot
 *  anchor class: async rail sections settle in a different order per boot, so
 *  row indices never transfer between boots — the shard-4 round-2 red lit the
 *  boot's OWN row 9, which was the notes tip, not the baseline boot's B). */
const motionT = '\x1b[<35;{X};{Y}M' // mode-1003, no button
const pressT = '\x1b[<0;{X};{Y}M'
const releaseT = '\x1b[<0;{X};{Y}m' // click dispatches on RELEASE
const dragT = '\x1b[<32;{X};{Y}M' // left held + motion

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
// The SEAT self row ('op (you)' — name PINNED via MERCURY_OPERATOR) and
// TABULA's "ask minerva" row are the rows the operator's bug screenshot
// showed lighting up — proven hover-armed targets. SETTLED anchor (the
// shard-4 wrong-row red): async rail sections (the RECENT scan placeholder
// resolving, the TABULA fold) land after first paint and shift every row
// below them, so coordinates may only be anchored on a grid that has
// stopped moving — both anchors painted AND byte-stable, or refuse loudly.
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
  // SETTLED-PHASE sends (the shard-4 red, both shapes): every pointer motion
  // is STRICT — it fires only through its observable gate, never on a tick
  // deadline into a boot phase that hasn't reached it (the old hard-deadline
  // produced lit=none by firing into an unpainted/unarmed rail; a bounded
  // fresh-boot retry papered over it and is absent). The chain of observables:
  //   1. the app ARMS any-motion tracking (DECSET 1003 on the raw stream) —
  //      a motion before that lands in an unarmed parser and vanishes;
  //   2. the TARGET row is painted AND the grid has stopped moving
  //      (awaitStableTicks — async rail sections shift rows after paint, so
  //      baseline-anchored coordinates are only valid on a settled layout).
  // A gate that never opens refuses the capture loudly (vshot exit 4) — a
  // wrong-frame observation is a capture failure, never an assertion input.
  // IN-BOOT targeting (`targetText`, round 2 of the shard-4 red): the
  // baseline boot proves the rows EXIST; the pointer coordinates resolve
  // against the SWEEP boot's own settled grid at fire time — each boot's
  // async sections settle in their own order, so indices never transfer.
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
    // CONTENT-anchored (round 12): hover is row-ID-keyed, so if a transient
    // line above settles between the motion and the final grid, the target
    // row's INDEX shifts while the fill correctly rides the row. The law is
    // "the fill sits on the target row", not "row indices match across two
    // separate boots" — CI's solo leg lit exactly one row, one index off.
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

// ── C. hover-hierarchy: chrome titles hover through INK, never fill ────
// The WORKFLOW telemetry header (RailPanel headerAction) at the wide
// both-rails cockpit: hovering it must paint ZERO surface2/ASH_RAISED cells
// in the right-rail band (the fill is the BODY-ROW selection grammar), the
// label must brighten info → infoShimmer, ONE click must open /workflows,
// and a typed draft must survive the open→esc round trip.
// SCOPING (scout audit): warm-ink maps userMessageBackground to ASH_RAISED,
// so transcript user turns legitimately paint the hover token in the CENTER
// column — the zero-fill assert is scoped to the right-rail band only.
{
  console.log('\n── C. chrome header hover: ink only, click opens, draft survives ──')
  const W = 160
  const H = 50
  const RIGHT_START = W - railPlanAt(W, true).telemetryW // 0-based first right-rail col
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
      // Content-anchored (the round-12 law): re-find the header in THIS grid.
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

// ── D. LEFT lane titles: SEAT is a display-only glance (retirement truth) ─────
// The SEAT lane's owning surface retired with the old multiplayer
// (commands/retired.ts); the glance paints identity and, until the new
// multiplayer lands, carries NO headerAction (HelmLanesRail: the SEAT glance
// is display-only). The old affordance pins — hover brightens to infoShimmer,
// one click opens the board — are KEPT INVERTED as poison: hover must NOT
// brighten past the info hue, a click must open NOTHING, and the retired
// board title can never paint. A revived affordance reds this section for a
// deliberate re-true.
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
