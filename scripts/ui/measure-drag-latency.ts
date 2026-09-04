#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-drag-latency-'))
const { runCompassArena, requireDist, pct, firstOutAfter, grabScreens } = await import(`${ROOT}/scripts/navigation/arena.ts`)
const { TAIL_SENTINEL } = await import(`${ROOT}/scripts/navigation/fixture1k.ts`)

requireDist()
if (!process.env.NODE_BIN) {
  const bunWhich = (globalThis as { Bun?: { which?: (bin: string) => string | null } }).Bun?.which?.('node') ?? null
  const shellWhich = spawnSync('which', ['node'], { encoding: 'utf8', env: process.env }).stdout?.trim() || null
  const found = [bunWhich, shellWhich, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].filter((c): c is string => !!c).find(c => existsSync(c))
  if (!found) {
    console.error('no node found — set NODE_BIN')
    process.exit(2)
  }
  process.env.NODE_BIN = found
}
process.stderr.write(`[drag-arena] node: ${process.env.NODE_BIN} (${dirname(process.env.NODE_BIN)})\n`)

const COLS = 120
const ROWS = 40
const argv = process.argv.slice(2)
const argOf = (flag: string, def: string): string => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1]! : def)
const CHAPTERS = Number(argOf('--chapters', '8')) || 8
const legsArg = argOf('--legs', '50:16,500:8')
const LEGS = legsArg === '0' ? [] : legsArg.split(',').map(s => {
  const [n, gap] = s.split(':').map(Number)
  return { n: n!, gap: gap ?? 8 }
})
const HOLD = Number(argOf('--hold', '200')) || 0
const jsonOut = argv.includes('--json') ? argOf('--json', '') : null
const SETTLE = 9000

type Summary = { n: number; p50: number; p95: number; max: number; mean: number }
const r1 = (x: number): number => Math.round(x * 100) / 100
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
const summarize = (xs: number[]): Summary => ({ n: xs.length, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)), max: r1(xs.length ? Math.max(...xs) : 0), mean: r1(xs.length ? sum(xs) / xs.length : 0) })
// eslint-disable-next-line no-control-regex
const ESC_RE = /(?:\[[0-9;?<>=]*[a-zA-Z@`~]|\][^]*(?:|\\)|[()][0-9A-B]|[78=>])/g
const cellsOf = (s: string): number => s.replace(ESC_RE, '').replace(/[\r\n]/g, '').length

const sgrText = (b: number, col0: number, row0: number, release = false): string => `\\x1b[<${b};${col0 + 1};${row0 + 1}${release ? 'm' : 'M'}`
const LEFT = 0
const MOTION = 0x20

process.stderr.write(`[drag-arena] silent run (${CHAPTERS} chapters, settle ${SETTLE} ms)…\n`)
const silent = await runCompassArena({ sends: [], seconds: Math.ceil(SETTLE / 1000) + 3, chapters: CHAPTERS })
let anchor = { col: 40, row: 12 }
let colLo = 30
let colHi = 100
let tailRow = -1
let screenRows: string[] = []
try {
  if (silent.outs.length === 0) {
    console.error('silent run produced no PTY output')
    process.exit(1)
  }
  const shots = grabScreens(silent, COLS, ROWS, [SETTLE - 300, -1])
  const final = shots.find(s => s.atMs === -1)!
  screenRows = final.rows
  tailRow = final.rows.findIndex(r => r.includes(TAIL_SENTINEL))
  if (tailRow < 0) {
    console.error('the fixture tail is not on screen after the settle — refusing to drag over an unknown screen')
    console.error(final.rows.slice(-12).join('\n'))
    process.exit(1)
  }
  colLo = 28
  colHi = 116
  anchor = { col: 32, row: Math.max(1, tailRow - 5) }
  const anchorRow = final.rows[anchor.row] ?? ''
  if (anchorRow.slice(26).trim().length === 0) {
    console.error(`anchor row ${anchor.row} carries no transcript text: ${JSON.stringify(anchorRow)}`)
    process.exit(1)
  }
} finally {
  silent.cleanup()
}
process.stderr.write(`[drag-arena] tail row ${tailRow}; anchor (${anchor.col},${anchor.row}); drag cols ${colLo}..${colHi}\n`)

function focusAt(k: number): { col: number; row: number } {
  const perRow = colHi - colLo + 1
  const start = anchor.col - colLo + 1 + k
  const row = anchor.row + Math.floor(start / perRow)
  return { col: colLo + (start % perRow), row: Math.min(row, tailRow + 6) }
}

type Leg = {
  n: number
  gapMs: number
  eventsPerSecondSent: number
  motionsSent: number
  latencyMs: Summary
  noPaintBeforeNext: number
  bytesPerEvent: Summary
  framesPerEvent: Summary
  cellsPerEvent: Summary
  dragWindow: { motions: number; frames: number; bytes: number; ptyReads: number; spanMs: number; framesPerSecond: number }
  trailingLagMs: number
  maxBacklog: number
  frameLenSummary: Summary
  writeWaitMs: Summary
}

async function legDrag(n: number, gap: number): Promise<Leg> {
  const sends: string[] = []
  sends.push(`${SETTLE}:${sgrText(LEFT, anchor.col, anchor.row)}`)
  let t = SETTLE + 40
  for (let k = 0; k < n; k++, t += gap) {
    const f = focusAt(k)
    sends.push(`${t}:${sgrText(LEFT | MOTION, f.col, f.row)}`)
  }
  const lastF = focusAt(n - 1)
  sends.push(`${t + gap}:${sgrText(LEFT, lastF.col, lastF.row, true)}`)
  const seconds = Math.ceil((t + gap + 2500) / 1000)
  const fluxPath = `${SCRATCH}/flux-${n}-${gap}-${Date.now()}.json`
  const run = await runCompassArena({ sends, seconds, chapters: CHAPTERS, extraEnv: { MERCURY_FLUX_PROBE: '1', MERCURY_FLUX_PROBE_TEE: fluxPath } })
  let paintEpochs: number[] = []
  let fluxFrames: { total: number; p50: number; p95: number; p99: number; maxMs: number } | null = null
  try {
    if (existsSync(fluxPath)) {
      const dump = JSON.parse(readFileSync(fluxPath, 'utf8')) as { frames: { total: number; p50: number; p95: number; p99: number; maxMs: number }; allMarks: { k: string; t: number }[]; epochMinusPerfNow: number }
      paintEpochs = dump.allMarks.filter(m => m.k === 'paint:entry').map(m => m.t + dump.epochMinusPerfNow)
      fluxFrames = dump.frames
    }
  } catch {
  }
  try {
    if (run.outs.length === 0 || run.sends.length === 0) {
      console.error(`drag n=${n}: no output/sends — ${run.driverOut.slice(-400)}`)
    }
    const isMotion = (b64: string): boolean => Buffer.from(b64, 'base64').toString('latin1').startsWith('\x1b[<32;')
    const motions = run.sends.filter(s => isMotion(s.b64))
    const release = run.sends.find(s => Buffer.from(s.b64, 'base64').toString('latin1').endsWith('m'))
    const lat: number[] = []
    let noPaint = 0
    const bytesPer: number[] = []
    const framesPer: number[] = []
    const cellsPer: number[] = []
    const paintsPer: number[] = []
    let zeroBytePaints = 0
    for (let i = 0; i < motions.length; i++) {
      const s = motions[i]!
      const next = motions[i + 1]?.sent ?? release?.sent ?? s.sent + 1000
      const o = firstOutAfter(run, s.sent, Math.min(next, s.sent + 1000))
      if (o) lat.push(o.ts - s.sent)
      else noPaint++
      bytesPer.push(sum(run.outs.filter(x => x.ts > s.sent && x.ts <= next).map(x => x.bytes)))
      const fr = run.teeLines.filter(tl => tl.ts > s.sent && tl.ts <= next)
      framesPer.push(fr.length)
      cellsPer.push(sum(fr.map(tl => cellsOf(tl.content ?? ''))))
      const paints = paintEpochs.filter(p => p > s.sent && p <= next).length
      paintsPer.push(paints)
      zeroBytePaints += Math.max(0, paints - fr.length)
    }
    const w0 = motions[0]?.sent ?? 0
    const wEnd = (release?.sent ?? motions.at(-1)?.sent ?? w0) + 1500
    const winFrames = run.teeLines.filter(tl => tl.ts > w0 && tl.ts <= wEnd)
    const winOuts = run.outs.filter(x => x.ts > w0 && x.ts <= wEnd)
    const lastMotionSent = motions.at(-1)?.sent ?? w0
    const lastFrameTs = winFrames.length ? Math.max(...winFrames.map(f => f.ts)) : lastMotionSent
    let maxBacklog = 0
    let fi = 0
    const framesSorted = [...winFrames].sort((a, b) => a.ts - b.ts)
    for (let i = 0; i < motions.length; i++) {
      while (fi < framesSorted.length && framesSorted[fi]!.ts <= motions[i]!.sent) fi++
      maxBacklog = Math.max(maxBacklog, i + 1 - fi)
    }
    const spanMs = Math.max(1, lastFrameTs - w0)
    return {
      n,
      gapMs: gap,
      eventsPerSecondSent: r1(1000 / gap),
      motionsSent: motions.length,
      latencyMs: summarize(lat),
      noPaintBeforeNext: noPaint,
      bytesPerEvent: summarize(bytesPer),
      framesPerEvent: summarize(framesPer),
      cellsPerEvent: summarize(cellsPer),
      dragWindow: { motions: motions.length, frames: winFrames.length, bytes: sum(winOuts.map(o => o.bytes)), ptyReads: winOuts.length, spanMs, framesPerSecond: r1((winFrames.length * 1000) / spanMs) },
      trailingLagMs: lastFrameTs - lastMotionSent,
      maxBacklog,
      frameLenSummary: summarize(winFrames.map(f => f.len ?? 0)),
      writeWaitMs: summarize(winFrames.map(f => (f as { waitMs?: number }).waitMs ?? 0)),
      paintsPerEvent: summarize(paintsPer),
      paintsInWindow: paintEpochs.filter(p => p > w0 && p <= wEnd).length,
      zeroBytePaints,
      fluxFrames,
    } as Leg & { paintsPerEvent: Summary; paintsInWindow: number; zeroBytePaints: number; fluxFrames: unknown }
  } finally {
    run.cleanup()
  }
}

const results: Record<string, unknown> = {
  harness: 'real bundle dist/mercury.mjs under node in a PTY (scripts/navigation/arena.ts + ptydrive.py), resumed fixture transcript, timed SGR sends; macOS host — not Windows/ConPTY timings',
  cols: COLS,
  rows: ROWS,
  chapters: CHAPTERS,
  settleMs: SETTLE,
  anchor,
  dragCols: [colLo, colHi],
  tailRow,
  screenBeforeDrag: screenRows,
  legs: [] as Leg[],
}
for (const { n, gap } of LEGS) {
  process.stderr.write(`[drag-arena] drag n=${n} gap=${gap}ms…\n`)
  const t0 = Date.now()
  ;(results.legs as Leg[]).push(await legDrag(n, gap))
  process.stderr.write(`[drag-arena] done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
}
for (const l of results.legs as (Leg & { paintsPerEvent: Summary; paintsInWindow: number; zeroBytePaints: number; fluxFrames: { total: number; p50: number; p95: number; maxMs: number } | null })[]) {
  console.log(
    `drag n=${l.n} gap=${l.gapMs}ms (${l.eventsPerSecondSent} ev/s sent): motions=${l.motionsSent}  latency p50=${l.latencyMs.p50} p95=${l.latencyMs.p95} max=${l.latencyMs.max}  noPaintBeforeNext=${l.noPaintBeforeNext}  bytes/ev p50=${l.bytesPerEvent.p50} p95=${l.bytesPerEvent.p95}  frames/ev p50=${l.framesPerEvent.p50} mean=${l.framesPerEvent.mean}  paints/ev p50=${l.paintsPerEvent.p50} mean=${l.paintsPerEvent.mean}  cells/ev p50=${l.cellsPerEvent.p50}  window: ${l.dragWindow.frames} frames / ${l.paintsInWindow} paints (${l.zeroBytePaints} zero-byte) / ${l.dragWindow.bytes} B over ${l.dragWindow.spanMs} ms (${l.dragWindow.framesPerSecond} f/s)  trailingLag=${l.trailingLagMs}ms  maxBacklog=${l.maxBacklog}  frameLen p50=${l.frameLenSummary.p50}  writeWait p50=${l.writeWaitMs.p50} max=${l.writeWaitMs.max}  fluxFrames(whole run)=${l.fluxFrames ? `${l.fluxFrames.total} p50=${l.fluxFrames.p50} p95=${l.fluxFrames.p95} max=${l.fluxFrames.maxMs}` : 'n/a'}`,
  )
}
type AttrScreen = { atMs: number; rows: string[]; reverse: number[][]; bg: [number, number, string][] }
function attrGrab(drive: string, offsets: number[]): AttrScreen[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [`${ROOT}/scripts/render-continuity/lib/attrgrab.py`, drive, String(COLS), String(ROWS), ...offsets.map(String)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`attrgrab failed: ${res.stderr}`)
  return (JSON.parse(res.stdout) as { screens: AttrScreen[] }).screens
}

async function legHold(holdMs: number): Promise<Record<string, unknown>> {
  const t0 = SETTLE
  const above = { col: anchor.col, row: 0 }
  const sends = [
    `${t0}:${sgrText(LEFT, anchor.col, anchor.row)}`,
    `${t0 + 40}:${sgrText(LEFT | MOTION, above.col, above.row)}`,
    `${t0 + 40 + holdMs}:${sgrText(LEFT, above.col, above.row, true)}`,
  ]
  const seconds = Math.ceil((t0 + 40 + holdMs + 2500) / 1000)
  const run = await runCompassArena({ sends, seconds, chapters: CHAPTERS })
  try {
    const press = run.sends[0]
    const release = run.sends[2]
    if (!press || !release || run.outs.length === 0) {
      console.error(`hold: no sends/output — ${run.driverOut.slice(-300)}`)
      return { holdMs, error: 'no output' }
    }
    const first = run.outs[0]!.ts
    const [pre, end] = attrGrab(run.paths.drive, [press.sent - first - 5, release.sent - first - 5])
    if (!pre || !end) return { holdMs, error: 'no screens' }
    const bgOf = (s: AttrScreen): Map<string, string> => new Map(s.bg.map(([x, y, c]) => [`${x},${y}`, c]))
    const preBg = bgOf(pre)
    const preRev = new Set(pre.reverse.map(([x, y]) => `${x},${y}`))
    const overlayRows = new Set<number>()
    for (const [x, y, c] of end.bg) if (x >= colLo && x <= colHi && preBg.get(`${x},${y}`) !== c) overlayRows.add(y)
    for (const [x, y] of end.reverse) if (x >= colLo && x <= colHi && !preRev.has(`${x},${y}`)) overlayRows.add(y)
    const rows = [...overlayRows].sort((a, b) => a - b)
    const anchorLine = (pre.rows[anchor.row] ?? '').slice(26, 60).trim()
    const anchorNow = anchorLine.length > 8 ? end.rows.findIndex(r => r.includes(anchorLine)) : -1
    const framesHeld = run.teeLines.filter(tl => tl.ts > press.sent && tl.ts <= release.sent).length
    const verdict =
      anchorNow < 0
        ? 'the anchor line is not on the screen at the release'
        : anchorNow === anchor.row
          ? 'no scroll happened while the pointer was held past the edge'
          : rows.includes(anchorNow)
            ? 'the highlight followed the text (the anchor line moved with the content and stayed highlighted)'
            : 'the highlight stayed on the old rows while the text moved under it (a translation fault)'
    console.log(
      `hold ${holdMs}ms above the pane: anchor line ${JSON.stringify(anchorLine)} row ${anchor.row} → ${anchorNow} (${anchorNow >= 0 ? anchorNow - anchor.row : '?'} rows scrolled; the tick rate ⇒ ≈${Math.floor(holdMs / 50) * 2})  highlighted rows ${rows.length ? `${rows[0]}..${rows.at(-1)}` : 'none'}  frames during the hold ${framesHeld} (${r1((framesHeld * 1000) / holdMs)}/s)\n  verdict: ${verdict}`,
    )
    console.log('  the screen at the release (highlighted rows marked ▌):')
    for (let y = 0; y < ROWS; y++) console.log(`  ${rows.includes(y) ? '▌' : ' '} ${(end.rows[y] ?? '').slice(0, 118)}`)
    return {
      holdMs,
      anchorRow: anchor.row,
      anchorRowAtRelease: anchorNow,
      rowsScrolled: anchorNow >= 0 ? anchorNow - anchor.row : null,
      highlightedRows: rows,
      framesDuringHold: framesHeld,
      verdict,
      screenAtPress: pre.rows,
      screenAtRelease: end.rows,
    }
  } finally {
    run.cleanup()
  }
}

if (HOLD > 0) {
  process.stderr.write(`[drag-arena] hold ${HOLD}ms above the pane…\n`)
  const t0 = Date.now()
  results.hold = await legHold(HOLD)
  process.stderr.write(`[drag-arena] done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2) + '\n')
process.exit(0)
