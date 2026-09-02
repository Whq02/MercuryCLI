#!/usr/bin/env bun
// ============================================================================
//  scripts/scroll/prove-scroll-travel.ts — transcript paging travels REAL
//  rows of REAL content (the content-coordinate scroll model).
//
//  The class this pins (the SPEED-pageup-travel-regression class): unmeasured virtual rows were
//  estimate-compressed (UNMEASURED_ESTIMATE_ROWS=3 vs real 6–16), so a page
//  step in composed rows crossed pageStep/estimate ITEMS — up to 104 rows of
//  content per 24-row press crossed sight-unseen, and offset rebuilds
//  displaced settled viewports (a measured 45% travel-loss class in the
//  field). The fix: the resting content pin re-derives the viewport-top
//  coordinate against the same offsets build the spacer renders from
//  (useVirtualScroll), so composed page jumps land and STAY row-exact as
//  crossed spans measure — the one owner of page travel (the never-wired
//  intent path was removed after a trace proved it dead).
//
//  LAWS (each settled PageUp press over a resumed 300-turn session):
//    · ROW-EXACT, PER PRESS — every press asks for a page of the viewport it
//      has AT THAT MOMENT (the scroll request the connector trace records:
//      delta = −(viewport − 2), the two overlap rows kept) and settles what
//      it asked within one row. The viewport is host truth AND changes
//      mid-run — the notification block under a keyless composer clears a
//      few seconds in and the transcript grows by its rows — so a step
//      pinned over the run (a mode, a bound) reads a changed viewport as a
//      lost press; the press's own request is the only honest yardstick.
//      The frames guard the request: a viewport can never exceed the pane
//      the frame shows;
//    · MONOTONE — every press moves up, none backward;
//    · SETTLED — the end-of-run grid matches the last settled mark exactly
//      (no post-settle drift);
//    · DELIVERED — every planned press became due and fired (a stuck press
//      is a paint-stall regression, the Q3 burst-stall class).
//
//  Timing (settle-tick medians) is REPORTED always but ASSERTED only under
//  PROVE_SCROLL_FULL=1 (solo lane runs): vshot ticks are wall-clock and the
//  pooled gate shares the CPU.
//
//  PROVE_SCROLL_FULL=1 additionally widens the matrix to all nine
//  regime × geometry cells the lane measured.
//
//  Run: ~/.bun/bin/bun run scripts/scroll/prove-scroll-travel.ts
// ============================================================================
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { paneSigs, regionOf, stepBounds, viewportRows, type Grid, type Sig } from './paneRuler.ts'

const ROOT = join(import.meta.dir, '../..')
const FULL = process.env.PROVE_SCROLL_FULL === '1'
const SCRATCH = `/tmp/mercury-scroll-prove-${process.pid}`

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

type Cell = {
  tag: string
  cols: number
  rows: number
  msgLines: number
  mix: boolean
  presses: number
  /** The commanded page step is the product's viewport − 2 overlap rows.
   *  The viewport is host truth — a signed-in home has no "not logged in"
   *  footer line, the jump-to-bottom pill reserves a row, the composer's
   *  newline hint keys on the terminal identity — so a frozen number reads
   *  one host and fails the other (26 rows at 120x50 on the runner's
   *  signed-in home, 24 on a signed-out darwin box). And the signature
   *  ruler under-reads the pane: blank separator rows between turns carry
   *  no signature, by a margin that shifts with the regime (tall turns show
   *  fewer separators per pane than short ones). The law is the relation,
   *  never the constant: the step's own press-to-press consistency, inside
   *  the measured content pane's bounds. */
}
const STANDING: Cell[] = [
  { tag: 'tall50', cols: 120, rows: 50, msgLines: 12, mix: false, presses: 12 },
  { tag: 'short38', cols: 120, rows: 38, msgLines: 3, mix: false, presses: 8 },
]
const FULL_EXTRA: Cell[] = [
  { tag: 'short50', cols: 120, rows: 50, msgLines: 3, mix: false, presses: 12 },
  { tag: 'tall38', cols: 120, rows: 38, msgLines: 12, mix: false, presses: 12 },
  { tag: 'mix50', cols: 120, rows: 50, msgLines: 3, mix: true, presses: 12 },
  { tag: 'mix38', cols: 120, rows: 38, msgLines: 3, mix: true, presses: 12 },
  { tag: 'short24', cols: 80, rows: 24, msgLines: 3, mix: false, presses: 10 },
  { tag: 'tall24', cols: 80, rows: 24, msgLines: 12, mix: false, presses: 10 },
  { tag: 'mix24', cols: 80, rows: 24, msgLines: 3, mix: true, presses: 10 },
]
/** The overlap rows a page step keeps from the previous page. */
const OVERLAP_ROWS = 2

// ── synthetic session (the measurement corpus) ───────────────────────
function seedSession(home: string, cell: Cell): void {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [ROOT])
  const sid = '00000000-aaaa-bbbb-cccc-a3a3a3a3a3a3'
  const projDir = join(home, 'projects', sanitizePath(ROOT))
  mkdirSync(projDir, { recursive: true })
  const linesForTurn = (n: number): number =>
    cell.mix ? (n % 2 === 1 ? 12 : 1) : cell.msgLines
  const lines: Record<string, unknown>[] = []
  let prevUuid: string | null = null
  const basePart = {
    isSidechain: false, userType: 'external', entrypoint: 'cli',
    cwd: ROOT, sessionId: sid, version: '1.0.0-beta.1', gitBranch: 'main',
  }
  for (let n = 1; n <= 300; n++) {
    const t = String(n).padStart(3, '0')
    const uUuid = `00000000-0000-4000-8000-${String(n * 2).padStart(12, '0')}`
    const aUuid = `00000000-0000-4000-8000-${String(n * 2 + 1).padStart(12, '0')}`
    lines.push({
      ...basePart, parentUuid: prevUuid, type: 'user', uuid: uUuid,
      message: { role: 'user', content: `TURN-${t} please survey the ledger rows for parcel ${t} and report drift` },
      timestamp: `2026-06-19T12:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`,
    })
    lines.push({
      ...basePart, parentUuid: uUuid, type: 'assistant', uuid: aUuid, requestId: `req_synth_${t}`,
      message: {
        id: `msg_synth_${t}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text:
          Array.from({ length: linesForTurn(n) }, (_, li) =>
            `TURN-${t} line ${String(li + 1).padStart(2, '0')} of the parcel ledger sweep holds steady against the recorded baseline here.`,
          ).join('\n') }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 50 },
      },
      timestamp: `2026-06-19T12:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.500Z`,
    })
    prevUuid = aUuid
  }
  // The session file holds RECORD lines — the shape the product opens.
  writeFileSync(join(projDir, `${sid}.jsonl`), encodeSeedTranscript(lines, sid))
}

// ── ruler v2: adjacency-chain content-row reconstruction ────────────────────
// Signatures come from the transcript PANE alone (paneRuler): the cockpit's
// rail echoes the last prompt at row 12 and the keyless chrome under the
// composer echoes the first — read whole, the grid's first signature was
// the rail's and never moved.
const allSigs = (grid: Grid): Sig[] => paneSigs(grid)

function analyze(cell: Cell, payload: {
  grid: Grid
  endReason: string
  marks?: Array<{ label: string; atTick: number; grid: Grid }>
}): {
  deltas: number[]
  tickGaps: number[]
  endDrift: number | null
  delivered: number
  /** The transcript region, measured: the most pane rows any frame of the
   *  drive shows (the scroller's viewport plus the sticky header and the
   *  jump pill's row when scrolled — paneRuler's cut). */
  viewport: number
} {
  const parityKey = (turn: number): string => (cell.mix ? String(turn % 2) : 'all')
  const grids: Grid[] = [...(payload.marks ?? []).map(m => m.grid), payload.grid]
  // The region of the PRESS frames (their mode) — the final and bottom
  // frames may wear different chrome and must not set the bounds.
  const viewport = regionOf((payload.marks ?? []).filter(m => /^p\d+$/.test(m.label)).map(m => m.grid))
  const edgeModes = new Map<string, Map<number, number>>()
  for (const g of grids) {
    const sigs = allSigs(g)
    for (let i = 0; i + 1 < sigs.length; i++) {
      const a = sigs[i]!, b = sigs[i + 1]!
      const d = b.row - a.row
      if (d <= 0) continue
      const key =
        b.turn === a.turn && b.sig !== 'u'
          ? `${parityKey(a.turn)}:${a.sig}>${b.sig}`
          : b.turn === a.turn + 1 && b.sig === 'u'
            ? `${parityKey(a.turn)}:${a.sig}>u+`
            : null
      if (!key) continue
      const m = edgeModes.get(key) ?? new Map<number, number>()
      m.set(d, (m.get(d) ?? 0) + 1)
      edgeModes.set(key, m)
    }
  }
  const edgeOf = (k: string): number | undefined => {
    const m = edgeModes.get(k)
    if (!m) return undefined
    return [...m.entries()].sort((x, y) => y[1] - x[1])[0]![0]
  }
  const parities = cell.mix ? ['1', '0'] : ['all']
  const offTable = new Map<string, Map<string, number>>()
  const heightTable = new Map<string, number>()
  for (const p of parities) {
    const L = cell.mix ? (p === '1' ? 12 : 1) : cell.msgLines
    const order = ['u', ...Array.from({ length: L }, (_, i) => String(i + 1).padStart(2, '0'))]
    const offs = new Map<string, number>([['u', 0]])
    let acc = 0
    for (let i = 0; i + 1 < order.length; i++) {
      const d = edgeOf(`${p}:${order[i]}>${order[i + 1]}`)
      if (d === undefined) throw new Error(`ruler edge missing: parity ${p} ${order[i]}>${order[i + 1]}`)
      acc += d
      offs.set(order[i + 1]!, acc)
    }
    const dEnd = edgeOf(`${p}:${order[order.length - 1]}>u+`)
    if (dEnd === undefined) throw new Error(`ruler edge missing: parity ${p} ${order[order.length - 1]}>u+`)
    offTable.set(p, offs)
    heightTable.set(p, acc + dEnd)
  }
  const turnTopCache = new Map<number, number>()
  const turnTop = (n: number): number => {
    let acc = turnTopCache.get(n)
    if (acc !== undefined) return acc
    acc = 0
    for (let i = 1; i < n; i++) acc += heightTable.get(parityKey(i))!
    turnTopCache.set(n, acc)
    return acc
  }
  const positionOf = (g: Grid): number | null => {
    const s = allSigs(g)[0]
    if (!s) return null
    const off = offTable.get(parityKey(s.turn))?.get(s.sig)
    if (off === undefined) return null
    return turnTop(s.turn) + off - s.row
  }
  const deltas: number[] = []
  const tickGaps: number[] = []
  let prevP: number | null = null
  let prevTick: number | null = null
  // The paging laws read the PAGING marks only — the jump-to-bottom leg is
  // a deliberate non-monotone hop, asserted by its own tail law in runCell.
  const travelMarks = (payload.marks ?? []).filter(m => m.label !== 'bottom' && m.label !== 'settled')
  for (const m of travelMarks) {
    const P = positionOf(m.grid)
    if (P !== null && prevP !== null) deltas.push(P - prevP)
    if (prevTick !== null) tickGaps.push(m.atTick - prevTick)
    if (P !== null) prevP = P
    prevTick = m.atTick
  }
  // SETTLED is judged between the last paging observation and the settle
  // mark that follows it ('final' → 'settled'); both precede the bottom
  // leg, so the jump never masks (or fakes) paging drift. Without a
  // 'settled' mark the very end of the run is the observation, as before.
  const settledMark = (payload.marks ?? []).find(m => m.label === 'settled')
  const endP = positionOf(settledMark !== undefined ? settledMark.grid : payload.grid)
  const endDrift = endP !== null && prevP !== null ? endP - prevP : null
  return { deltas, tickGaps, endDrift, delivered: travelMarks.length, viewport }
}

// ── drive one cell ──────────────────────────────────────────────────────────
function runCell(cell: Cell): void {
  console.log(`\n── scroll-travel: ${cell.tag} (${cell.cols}x${cell.rows}, ${cell.mix ? 'mixed' : `${cell.msgLines}-line`} turns, ${cell.presses} presses)`)
  const home = join(SCRATCH, `home-${cell.tag}`)
  seedSession(home, cell)
  const PAGEUP = '\x1b[5~'
  const sends: Record<string, unknown>[] = []
  sends.push({ atTick: 999, awaitText: '❯', minTick: 10, awaitSettleTicks: 4, awaitStableTicks: 3, data: PAGEUP, mark: 'p00' })
  for (let i = 1; i < cell.presses; i++) {
    sends.push({ atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 2, awaitStableTicks: 4, data: PAGEUP, mark: `p${String(i).padStart(2, '0')}` })
  }
  sends.push({ atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 4, data: '', mark: 'final' })
  // The settle observation closes the paging phase (the SETTLED law reads
  // final → settled), then the JUMP-TO-BOTTOM leg: ctrl+end from deep in
  // the transcript must land on the tail and STAY there — the stuck-mid-
  // transcript class is the poison.
  sends.push({ atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 3, data: '', mark: 'settled' })
  sends.push({ atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 4, awaitStableTicks: 4, data: '\x1b[1;5F', mark: 'bottom' })
  const out = join(SCRATCH, `${cell.tag}.json`)
  const cfgPath = join(SCRATCH, `${cell.tag}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', join(ROOT, 'dist/mercury.mjs'), '--resume', '00000000-aaaa-bbbb-cccc-a3a3a3a3a3a3'],
    cols: cell.cols, rows: cell.rows, total: 500, sends, out,
  }))
  // The connector trace seam records every scroll request the page key
  // makes (the viewport before the move, the delta asked, the span) and
  // every virtual-list render (the settled top, the viewport, stickiness):
  // the requests ARE the per-press yardstick; the renders are diagnosis.
  const trace = join(SCRATCH, `${cell.tag}-trace.jsonl`)
  const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(420000), cwd: ROOT,
    env: {
      ...process.env,
      MERCURY_FULLSCREEN: '1',      MERCURY_DECK_COMPANION: '0',
      MERCURY_CONFIG_DIR: home,
      MERCURY_CONNECTOR_TRACE: trace,
      // The same display pins as the reflow cell: the press gates read the
      // whole grid, and an animating critter or a live seconds cell decides
      // when a press counts as settled instead of the pane.
      MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
    },
  })
  check(`${cell.tag}: vshot exit 0`, res.status === 0, `status ${res.status}`)
  if (res.status !== 0) {
    console.log(res.stdout?.slice(-1500) ?? '')
    console.error(res.stderr?.slice(-1500) ?? '')
    return
  }
  const undelivered = /UNDELIVERED-SENDS/.test(res.stdout ?? '')
  const payload = JSON.parse(readFileSync(out, 'utf-8'))
  type Req = { ev: string; delta?: number; top?: number; max?: number; viewport?: number; sticky?: boolean; range?: [number, number]; scroll?: { top: number; pending: number; sticky: boolean; viewport: number; height: number } | null }
  let reqs: Req[] = []
  try {
    const lines = readFileSync(trace, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as Req } catch { return null } }).filter((r): r is Req => r !== null)
    reqs = lines.filter(r => r.ev === 'scroll-request' && typeof r.delta === 'number' && r.delta < 0)
    const rends = lines.filter(r => r.ev === 'list-render' && r.scroll)
    console.log(`  scroll requests (delta@top/viewport, span): ${reqs.map(r => `${r.delta}@${r.top}/${r.viewport}${r.sticky ? 's' : ''}·${r.max}`).join(' ')}`)
    console.log(`  list renders (range@top/viewport/height): ${rends.slice(-40).map(r => `[${r.range![0]},${r.range![1]})@${r.scroll!.top}${r.scroll!.sticky ? 's' : ''}/${r.scroll!.viewport}/${r.scroll!.height}`).join(' ')}`)
  } catch {
    console.log('  (no connector trace this run)')
  }
  const a = analyze(cell, payload)
  const shown = a.deltas.map(d => String(d)).join(',')
  const bounds = stepBounds(a.viewport)
  console.log(`  deltas: [${shown}] endDrift=${a.endDrift} · transcript region ${a.viewport} rows (press frames' mode) · viewports asked ${reqs.map(r => r.viewport).join(',')} · step bounds if the region were the viewport [${bounds.floor}, ${bounds.ceiling}]`)
  // DELIVERED — every planned press fired (p00..pN-1 + final).
  check(`${cell.tag}: all sends delivered`, !undelivered && a.delivered === cell.presses + 1,
    `delivered ${a.delivered}/${cell.presses + 1}${undelivered ? ' (vshot reported stuck sends)' : ''}`)
  // The measured region is a real pane (a blank or wrong-frame drive reads
  // 0 and must never be the pane a press is judged against).
  check(`${cell.tag}: the transcript region measured from the frames is a real pane (≥ 6 rows)`, a.viewport >= 6, `region ${a.viewport}`)
  // NO LOST PRESS — every page key reached the scroller as one request.
  check(`${cell.tag}: every press reached the scroller (requests = presses)`, reqs.length === cell.presses, `${reqs.length} requests for ${cell.presses} presses`)
  // ROW-EXACT PER PRESS + MONOTONE: press i asked for a page of ITS
  // viewport (delta = −(viewport − overlap)), the viewport never exceeds
  // the pane the press's own frame shows, and the settle honours the ask
  // within one row.
  const pressFrames = (payload.marks ?? []).filter((m: { label: string }) => /^p\d+$/.test(m.label)).map((m: { grid: Grid }) => m.grid)
  for (let i = 0; i < a.deltas.length; i++) {
    const d = a.deltas[i]!
    const r = reqs[i]
    if (r === undefined || typeof r.delta !== 'number' || typeof r.viewport !== 'number') {
      check(`${cell.tag}: press ${i + 1} has its request`, false, 'no scroll request recorded for this press')
      continue
    }
    check(`${cell.tag}: press ${i + 1} asked a page of its own viewport (${r.viewport} − ${OVERLAP_ROWS})`, -r.delta === r.viewport - OVERLAP_ROWS,
      `asked ${-r.delta} rows at viewport ${r.viewport}`)
    const frame = pressFrames[i + 1] ?? pressFrames[pressFrames.length - 1]
    const paneNow = frame ? viewportRows(frame) : a.viewport
    check(`${cell.tag}: press ${i + 1} viewport never exceeds the pane on screen`, r.viewport <= paneNow + 1, `viewport ${r.viewport} vs pane ${paneNow}`)
    check(`${cell.tag}: press ${i + 1} row-exact (settled what it asked)`, Math.abs(-d - -r.delta) <= 1,
      `settled ${-d} rows vs asked ${-r.delta}`)
    check(`${cell.tag}: press ${i + 1} monotone up`, d < 0, `delta ${d}`)
  }
  // SETTLED — the end grid does not drift off the last settled mark.
  check(`${cell.tag}: no post-settle drift`, a.endDrift === 0, `endDrift ${a.endDrift}`)
  // THE ENTRY LAW — the resumed fullscreen transcript OPENS at the tail
  // (the erratic-entry poison is a viewport parked at an earlier message).
  // p00's mark grid is the resting state before the first press.
  const entryGrid = (payload.marks ?? []).find((m: { label: string }) => m.label === 'p00')?.grid
  const entryMax = entryGrid !== undefined
    ? allSigs(entryGrid).reduce((best, s) => Math.max(best, s.turn), 0)
    : 0
  check(`${cell.tag}: the resumed transcript opens at the tail`,
    entryMax >= 299, `max visible turn at entry ${entryMax} of 300`)
  // THE TAIL LAW — from deep in the transcript, ctrl+end (scroll:bottom)
  // lands on the tail and STAYS: the final frame shows the newest turn.
  // The poison is the jump parking mid-transcript (or bouncing off it).
  const endSigs = allSigs(payload.grid)
  const maxTurn = endSigs.reduce((best, s) => Math.max(best, s.turn), 0)
  check(`${cell.tag}: jump-to-bottom lands on the tail (newest turn visible)`,
    maxTurn >= 299, `max visible turn ${maxTurn} of 300`)
  const gaps = [...a.tickGaps].sort((x, y) => x - y)
  const gapP50 = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : NaN
  console.log(`  settle ticks p50=${gapP50} (200ms ticks; report${FULL ? '+assert' : '-only in pooled runs'})`)
  if (FULL) check(`${cell.tag}: settle p50 within budget`, gapP50 <= 30, `p50 ${gapP50} ticks`)
}

mkdirSync(SCRATCH, { recursive: true })
const cells = FULL ? [...STANDING, ...FULL_EXTRA] : STANDING
for (const cell of cells) runCell(cell)

if (failures > 0) {
  console.log(`\nscroll-travel: RED (${failures}/${checks} checks failed) — captures kept at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nscroll-travel: green (${checks} checks)`)
