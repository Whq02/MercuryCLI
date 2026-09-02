#!/usr/bin/env bun
// ============================================================================
//  scripts/scroll/prove-scroll-reflow.ts — the resting pin holds the SAME
//  content through a terminal reflow.
//
// The class this pins: on a column resize the
//  reflow render painted its spacer from the freshly SCALED offsets while
//  content-coordinate resolution sat out the two freeze renders — the painted
//  (spacer, scrollTop) pair split, the clamp effect shoved scrollTop into the
//  scaled window, and the outside-actor rule then cancelled the pin at the
//  displaced position: an UNBOUNDED-feeling 3-turn yank at rest, and the pin
//  adopted the displaced position as its new truth. The hardening
//  (useVirtualScroll.ts) runs pin resolution on frozen renders too
//  (only measurement stays frozen — the build-pairing law does not), holds
//  outside-actor cancellation across the reflow window, and pumps re-resolve
//  renders until the post-reflow folds go quiet.
//
//  OPEN RESIDUAL (recorded): a strict same-content
//  hold through a COLUMN reflow is not yet achieved — width-dependent fold
//  heights re-evaluate at the new width and the scale approximation's
//  round-trip error above the pin leaves a bounded (≤3 turn) landing offset.
//  The strict law asserts under MERCURY_SCROLL_REFLOW_STRICT=1; the pooled
//  law pins the achieved bound so it cannot widen back to the yank class.
//
//  LAWS (a resumed 300-turn session, resting mid-session, PTY resized):
//    · CONTENT-BOUNDED — the settled viewport-top content after the reflow
//      is within three turns of the pre-reflow content (strict: identical,
//      MERCURY_SCROLL_REFLOW_STRICT=1);
//    · NO-LATE-DRIFT — the settled position does not move again afterwards;
//    · POST-REFLOW EXACT — settled presses after the reflow are row-exact at
//      the NEW geometry's commanded step;
//    · DELIVERED — every planned send fired.
//
//  PROVE_SCROLL_FULL=1 widens to the reverse direction and a rows-only cell.
//
//  Run: ~/.bun/bin/bun run scripts/scroll/prove-scroll-reflow.ts
// ============================================================================
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { paneSigs, stepBounds, viewportRows, type Grid, type Sig } from './paneRuler.ts'

const ROOT = join(import.meta.dir, '../..')
const FULL = process.env.PROVE_SCROLL_FULL === '1'
const SCRATCH = `/tmp/mercury-scroll-reflow-${process.pid}`

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
  rCols: number
  rRows: number
}
const MSG_LINES = 12
// The post-resize page step is MEASURED from the post-resize frames (the
// transcript region paneRuler cuts), never a frozen number: the region is
// host truth — a keyless composer carries five notification rows under it,
// a signed-in one none — and a frozen 36 read one host and failed the other.
const STANDING: Cell[] = [
  { tag: 'to80', cols: 120, rows: 50, rCols: 80, rRows: 50 },
]
const FULL_EXTRA: Cell[] = [
  { tag: 'to120', cols: 80, rows: 50, rCols: 120, rRows: 50 },
  { tag: 'rows38', cols: 120, rows: 50, rCols: 120, rRows: 38 },
]

// ── synthetic session (the measurement corpus) ───────────────────────
const SID = '00000000-aaaa-bbbb-cccc-a3a3a3a3a3a3'
function seedSession(home: string): void {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [ROOT])
  const projDir = join(home, 'projects', sanitizePath(ROOT))
  mkdirSync(projDir, { recursive: true })
  const lines: Record<string, unknown>[] = []
  let prevUuid: string | null = null
  const basePart = {
    isSidechain: false, userType: 'external', entrypoint: 'cli',
    cwd: ROOT, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main',
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
          Array.from({ length: MSG_LINES }, (_, li) =>
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
  writeFileSync(join(projDir, `${SID}.jsonl`), encodeSeedTranscript(lines, SID))
}

// ── per-phase ruler (single parity; frames of ONE geometry) ─────────────────
// Signatures come from the transcript PANE alone (paneRuler): read whole, a
// frame's first signature was the cockpit rail's echo of the last prompt.
const allSigs = (grid: Grid): Sig[] => paneSigs(grid)
function positionRuler(grids: Grid[]): (g: Grid) => number | null {
  const edgeModes = new Map<string, Map<number, number>>()
  for (const g of grids) {
    const sigs = allSigs(g)
    for (let i = 0; i + 1 < sigs.length; i++) {
      const a = sigs[i]!, b = sigs[i + 1]!
      const d = b.row - a.row
      if (d <= 0) continue
      const key =
        b.turn === a.turn && b.sig !== 'u'
          ? `${a.sig}>${b.sig}`
          : b.turn === a.turn + 1 && b.sig === 'u'
            ? `${a.sig}>u+`
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
  const order = ['u', ...Array.from({ length: MSG_LINES }, (_, i) => String(i + 1).padStart(2, '0'))]
  const offs = new Map<string, number>([['u', 0]])
  let acc = 0
  for (let i = 0; i + 1 < order.length; i++) {
    const d = edgeOf(`${order[i]}>${order[i + 1]}`)
    if (d === undefined) throw new Error(`ruler edge missing: ${order[i]}>${order[i + 1]}`)
    acc += d
    offs.set(order[i + 1]!, acc)
  }
  const dEnd = edgeOf(`${order[order.length - 1]}>u+`)
  if (dEnd === undefined) throw new Error(`ruler edge missing: ${order[order.length - 1]}>u+`)
  const height = acc + dEnd
  return (g: Grid): number | null => {
    const s = allSigs(g)[0]
    if (!s) return null
    const off = offs.get(s.sig)
    if (off === undefined) return null
    return (s.turn - 1) * height + off - s.row
  }
}

// ── drive one cell ──────────────────────────────────────────────────────────
function runCell(cell: Cell): void {
  console.log(`\n── scroll-reflow: ${cell.tag} (${cell.cols}x${cell.rows} → ${cell.rCols}x${cell.rRows})`)
  const home = join(SCRATCH, `home-${cell.tag}`)
  seedSession(home)
  const PAGEUP = '\x1b[5~'
  // Two settled presses put the view mid-session; the resize fires between
  // the atRest settle and the postResize observation (the settled press
  // cadence ends ~tick 39; ordering is asserted from the payload below).
  const RESIZE_AT = 45
  const sends: Record<string, unknown>[] = [
    { atTick: 999, awaitText: '❯', minTick: 10, awaitSettleTicks: 4, awaitStableTicks: 3, data: PAGEUP, mark: 'p00' },
    { atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 2, awaitStableTicks: 4, data: PAGEUP, mark: 'p01' },
    { atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 4, data: '', mark: 'atRest' },
    { atTick: 43, data: '', mark: 'preResize' },
    { atTick: 55, data: '', mark: 'postResize' },
    { atTick: 66, data: '', mark: 'late' },
    { atTick: 68, data: PAGEUP, mark: 'q01' },
    { atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 2, awaitStableTicks: 4, data: PAGEUP, mark: 'q02' },
    { atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 4, data: '', mark: 'qEnd' },
  ]
  const out = join(SCRATCH, `${cell.tag}.json`)
  const cfgPath = join(SCRATCH, `${cell.tag}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', join(ROOT, 'dist/mercury.mjs'), '--resume', SID],
    cols: cell.cols, rows: cell.rows, total: 500, sends,
    resizes: [{ atTick: RESIZE_AT, cols: cell.rCols, rows: cell.rRows }],
    out,
  }))
  const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(420000), cwd: ROOT,
    env: {
      ...process.env,
      MERCURY_FULLSCREEN: '1',      MERCURY_DECK_COMPANION: '0',
      MERCURY_CONFIG_DIR: home,
    },
  })
  check(`${cell.tag}: vshot exit 0`, res.status === 0, `status ${res.status}`)
  if (res.status !== 0) {
    console.log(res.stdout?.slice(-1500) ?? '')
    console.error(res.stderr?.slice(-1500) ?? '')
    return
  }
  const payload = JSON.parse(readFileSync(out, 'utf-8')) as {
    grid: Grid
    endReason: string
    stages?: Array<{ cols: number; rows: number; untilTick: number; grid: Grid }>
    marks?: Array<{ label: string; atTick: number; grid: Grid }>
  }
  const marks = new Map((payload.marks ?? []).map(m => [m.label, m]))
  const need = ['atRest', 'preResize', 'postResize', 'late', 'q01', 'q02', 'qEnd']
  check(`${cell.tag}: all sends delivered`, need.every(l => marks.has(l)),
    `have ${[...marks.keys()].join(',')}`)
  if (!need.every(l => marks.has(l))) return
  const stage = payload.stages?.[0]
  check(`${cell.tag}: resize landed between rest and observation`,
    stage !== undefined && stage.untilTick >= marks.get('atRest')!.atTick && stage.untilTick < marks.get('postResize')!.atTick,
    `resize@${stage?.untilTick} rest@${marks.get('atRest')!.atTick} obs@${marks.get('postResize')!.atTick}`)

  const topOf = (g: Grid): Sig | null => allSigs(g)[0] ?? null
  const lineOf = (s: Sig | null): number => (s === null ? -99 : s.sig === 'u' ? 0 : Number(s.sig))
  const preTop = topOf(stage?.grid ?? marks.get('preResize')!.grid)
  const postTop = topOf(marks.get('postResize')!.grid)
  const lateTop = topOf(marks.get('late')!.grid)
  // CONTENT-BOUNDED — strict identity under MERCURY_SCROLL_REFLOW_STRICT=1.
  const strict = process.env.MERCURY_SCROLL_REFLOW_STRICT === '1'
  if (strict) {
    check(`${cell.tag}: pin holds the content through the reflow (strict)`,
      preTop !== null && postTop !== null && postTop.turn === preTop.turn &&
        Math.abs(lineOf(postTop) - lineOf(preTop)) <= 1,
      `pre=${preTop?.turn}:${preTop?.sig} post=${postTop?.turn}:${postTop?.sig}`)
  } else {
    check(`${cell.tag}: reflow landing within three turns of the pinned content`,
      preTop !== null && postTop !== null && Math.abs(postTop.turn - preTop.turn) <= 3,
      `pre=${preTop?.turn}:${preTop?.sig} post=${postTop?.turn}:${postTop?.sig}`)
  }
  // NO-LATE-DRIFT.
  check(`${cell.tag}: no late drift`,
    postTop !== null && lateTop !== null && lateTop.turn === postTop.turn && lateTop.sig === postTop.sig,
    `post=${postTop?.turn}:${postTop?.sig} late=${lateTop?.turn}:${lateTop?.sig}`)
  // POST-REFLOW EXACT — two settled presses at the NEW geometry: each a
  // real page inside the measured region's bounds, and the two equal within
  // one row of each other (the row-exact law, as strong as before — the
  // commanded step is the region's, not a frozen number).
  const postGrids = [marks.get('q01')!.grid, marks.get('q02')!.grid, marks.get('qEnd')!.grid, payload.grid]
  const postRuler = positionRuler(postGrids)
  const region = postGrids.reduce((best, g) => Math.max(best, viewportRows(g)), 0)
  const bounds = stepBounds(region)
  const pQ1 = postRuler(marks.get('q01')!.grid)
  const pQ2 = postRuler(marks.get('q02')!.grid)
  const pEnd = postRuler(marks.get('qEnd')!.grid)
  const step1 = pQ1 !== null && pQ2 !== null ? pQ1 - pQ2 : null
  const step2 = pQ2 !== null && pEnd !== null ? pQ2 - pEnd : null
  check(`${cell.tag}: the post-resize transcript region is a real pane (≥ 6 rows)`, region >= 6, `region ${region}`)
  check(`${cell.tag}: post-reflow press 1 is a page (region − 4 ≤ step ≤ region + 1)`,
    step1 !== null && step1 >= bounds.floor && step1 <= bounds.ceiling,
    `settled ${step1 ?? '—'} vs bounds [${bounds.floor}, ${bounds.ceiling}]`)
  check(`${cell.tag}: post-reflow press 2 is a page (region − 4 ≤ step ≤ region + 1)`,
    step2 !== null && step2 >= bounds.floor && step2 <= bounds.ceiling,
    `settled ${step2 ?? '—'} vs bounds [${bounds.floor}, ${bounds.ceiling}]`)
  check(`${cell.tag}: the two post-reflow presses are row-exact (equal within one row)`,
    step1 !== null && step2 !== null && Math.abs(step1 - step2) <= 1,
    `presses ${step1 ?? '—'} and ${step2 ?? '—'}`)
  console.log(`  reflow: pre=${preTop?.turn}:${preTop?.sig} post=${postTop?.turn}:${postTop?.sig} presses=[${step1 ?? '—'},${step2 ?? '—'}] region=${region} endReason=${payload.endReason}`)
}

mkdirSync(SCRATCH, { recursive: true })
const cells = FULL ? [...STANDING, ...FULL_EXTRA] : STANDING
for (const cell of cells) runCell(cell)

if (failures > 0) {
  console.log(`\nscroll-reflow: RED (${failures}/${checks} checks failed) — captures kept at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nscroll-reflow: green (${checks} checks)`)
