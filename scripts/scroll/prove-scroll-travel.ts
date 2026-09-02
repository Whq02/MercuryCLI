#!/usr/bin/env bun
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { paneSigs, regionOf, stepBounds, type Grid, type Sig } from './paneRuler.ts'

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
const OVERLAP_ROWS = 2

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
  writeFileSync(join(projDir, `${sid}.jsonl`), encodeSeedTranscript(lines, sid))
}

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
  viewport: number
} {
  const parityKey = (turn: number): string => (cell.mix ? String(turn % 2) : 'all')
  const grids: Grid[] = [...(payload.marks ?? []).map(m => m.grid), payload.grid]
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
  const travelMarks = (payload.marks ?? []).filter(m => m.label !== 'bottom' && m.label !== 'settled')
  for (const m of travelMarks) {
    const P = positionOf(m.grid)
    if (P !== null && prevP !== null) deltas.push(P - prevP)
    if (prevTick !== null) tickGaps.push(m.atTick - prevTick)
    if (P !== null) prevP = P
    prevTick = m.atTick
  }
  const settledMark = (payload.marks ?? []).find(m => m.label === 'settled')
  const endP = positionOf(settledMark !== undefined ? settledMark.grid : payload.grid)
  const endDrift = endP !== null && prevP !== null ? endP - prevP : null
  return { deltas, tickGaps, endDrift, delivered: travelMarks.length, viewport }
}

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
  sends.push({ atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 3, data: '', mark: 'settled' })
  sends.push({ atTick: 999, requireAwait: true, awaitText: 'TURN-', minTick: 1, awaitSettleTicks: 4, awaitStableTicks: 4, data: '\x1b[1;5F', mark: 'bottom' })
  const out = join(SCRATCH, `${cell.tag}.json`)
  const cfgPath = join(SCRATCH, `${cell.tag}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', join(ROOT, 'dist/mercury.mjs'), '--resume', '00000000-aaaa-bbbb-cccc-a3a3a3a3a3a3'],
    cols: cell.cols, rows: cell.rows, total: 500, sends, out,
  }))
  const trace = join(SCRATCH, `${cell.tag}-trace.jsonl`)
  const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(420000), cwd: ROOT,
    env: {
      ...process.env,
      MERCURY_FULLSCREEN: '1',      MERCURY_DECK_COMPANION: '0',
      MERCURY_CONFIG_DIR: home,
      MERCURY_CONNECTOR_TRACE: trace,
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
  try {
    type Req = { ev: string; delta?: number; top?: number; max?: number; viewport?: number; sticky?: boolean; range?: [number, number]; scroll?: { top: number; pending: number; sticky: boolean; viewport: number; height: number } | null }
    const lines = readFileSync(trace, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as Req } catch { return null } }).filter((r): r is Req => r !== null)
    const reqs = lines.filter(r => r.ev === 'scroll-request')
    const rends = lines.filter(r => r.ev === 'list-render' && r.scroll)
    console.log(`  scroll requests (delta@top/viewport, span): ${reqs.map(r => `${r.delta}@${r.top}/${r.viewport}${r.sticky ? 's' : ''}·${r.max}`).join(' ')}`)
    console.log(`  list renders (range@top/viewport/height): ${rends.slice(-40).map(r => `[${r.range![0]},${r.range![1]})@${r.scroll!.top}${r.scroll!.sticky ? 's' : ''}/${r.scroll!.viewport}/${r.scroll!.height}`).join(' ')}`)
  } catch {
    console.log('  (no connector trace this run)')
  }
  const a = analyze(cell, payload)
  const shown = a.deltas.map(d => String(d)).join(',')
  const settled = a.deltas.map(d => -d)
  const stepCounts = new Map<number, number>()
  for (const s of settled) stepCounts.set(s, (stepCounts.get(s) ?? 0) + 1)
  const step = [...stepCounts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? 0
  const bounds = stepBounds(a.viewport)
  console.log(`  deltas: [${shown}] endDrift=${a.endDrift} · step mode ${step} · transcript region ${a.viewport} rows ⇒ step bounds [${bounds.floor}, ${bounds.ceiling}]`)
  check(`${cell.tag}: all sends delivered`, !undelivered && a.delivered === cell.presses + 1,
    `delivered ${a.delivered}/${cell.presses + 1}${undelivered ? ' (vshot reported stuck sends)' : ''}`)
  check(`${cell.tag}: the transcript region measured from the frames is a real pane (≥ 6 rows)`, a.viewport >= 6, `region ${a.viewport}`)
  check(`${cell.tag}: page step ≥ region − 4`, step >= bounds.floor, `step ${step} vs floor ${bounds.floor}`)
  check(`${cell.tag}: page step ≤ region + 1`, step <= bounds.ceiling, `step ${step} vs ceiling ${bounds.ceiling}`)
  for (let i = 0; i < a.deltas.length; i++) {
    const d = a.deltas[i]!
    check(`${cell.tag}: press ${i + 1} row-exact`, Math.abs(-d - step) <= 1,
      `settled ${-d} rows vs the mode step ${step}`)
    check(`${cell.tag}: press ${i + 1} monotone up`, d < 0, `delta ${d}`)
  }
  check(`${cell.tag}: no post-settle drift`, a.endDrift === 0, `endDrift ${a.endDrift}`)
  const entryGrid = (payload.marks ?? []).find((m: { label: string }) => m.label === 'p00')?.grid
  const entryMax = entryGrid !== undefined
    ? allSigs(entryGrid).reduce((best, s) => Math.max(best, s.turn), 0)
    : 0
  check(`${cell.tag}: the resumed transcript opens at the tail`,
    entryMax >= 299, `max visible turn at entry ${entryMax} of 300`)
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
