#!/usr/bin/env bun
// ============================================================================
//  scripts/motion/prove-splash-choreography.ts — the boot splash MOTION LAWS
//  (the one-scene rework).
//
//  The cinematic boot is ONE continuous scene: the composed hero paints at
//  arrival, the code trace flows out of it and routes around it, the field
//  dissolves into the handoff hold, and a mid-animation resize reseats the
//  same run. Pinned here so none of it can silently regress:
//
//   LAW 1 · hero permanence — every post-arrival frame renders the hero rows
//           char-identical to the arrival frame (the hard-cut class is dead;
//           the final frame may swap only the ready line for the hold hint).
//   LAW 2 · no blank frame — no paint unit after arrival drops below the
//           arrival frame's fill (nothing ever clears the scene).
//   LAW 3 · settle continuity — fill moves in bounded steps (no single-unit
//           cliff), and the run's final frame is the settled hero + hint.
//   LAW 4 · cadence — trace-window synced frames pace at the tick with no
//           starvation gap (bounds generous for loaded runners).
//   LAW 5 · resize convergence — a mid-trace shrink continues the run, never
//           addresses a cell beyond the new grid, and ends in the settled
//           hero + hint at the new geometry.
//   LAW 6 · reduced motion — no trace, no fade: the hero arrives and holds
//           (the calmest path), bounded wall time.
//   LAW 7 · fill balance — at the trace's peak the 3x3 region densities have
//           no dead ninth and the overall fill sits in the class band.
//
//  Substrate: scripts/motion/splash-reel.py (PTY capture with ms timestamps →
//  pyte replay into paint-unit frames). /usr/bin/python3 carries pyte — the
//  same interpreter every vshot capture in the repo already requires.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const REEL = join(ROOT, 'scripts/motion/splash-reel.py')
const PY = '/usr/bin/python3'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const scratch = mkdtempSync(join(tmpdir(), 'glide-splash-'))

interface Frame {
  i: number
  t: number
  synced: boolean
  cols: number
  rows: number
  fill: number
  regions: number[][]
}
interface Report {
  frames: number
  blank_frames: number[]
  per_frame: Frame[]
}

function cell(
  name: string,
  cols: number,
  rows: number,
  extra: string[] = [],
): { report: Report; framesDir: string; raw: Buffer; exit: number } {
  const reel = join(scratch, `${name}.jsonl`)
  const framesDir = join(scratch, `${name}-frames`)
  const cap = spawnSync(
    PY,
    [REEL, 'capture', '--cols', String(cols), '--rows', String(rows), '--out', reel, '--deadline', '25', ...extra],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (cap.status !== 0) throw new Error(`capture ${name} failed: ${cap.stderr}`)
  const exit = (JSON.parse(cap.stdout) as { exit: { code?: number } }).exit?.code ?? -1
  for (const [sub, out] of [
    ['render', ['--outdir', framesDir]],
    ['report', ['--json', join(scratch, `${name}.report.json`)]],
  ] as const) {
    const r = spawnSync(PY, [REEL, sub, '--reel', reel, ...out], { encoding: 'utf8', timeout: 120_000 })
    if (r.status !== 0) throw new Error(`${sub} ${name} failed: ${r.stderr}`)
  }
  const report = JSON.parse(readFileSync(join(scratch, `${name}.report.json`), 'utf8')) as Report
  let raw = Buffer.alloc(0)
  for (const line of readFileSync(reel, 'utf8').split('\n')) {
    if (!line.includes('"b"')) continue
    raw = Buffer.concat([raw, Buffer.from((JSON.parse(line) as { b: string }).b, 'base64')])
  }
  return { report, framesDir, raw, exit }
}

const frameText = (dir: string, i: number): string[] =>
  readFileSync(join(dir, `frame-${String(i).padStart(4, '0')}.txt`), 'utf8').split('\n')

console.log('── SPLASH choreography: the one-scene motion laws ──')

// ── the natural cinematic run (LAWS 1-4, 7) ─────────────────────────────────
{
  const { report, framesDir, exit } = cell('natural', 120, 38)
  check('natural run hands off (exit 0)', exit === 0, `exit=${exit}`)
  const pf = report.per_frame
  // 0.02 (was 0.03): the enter-copy shrink ('↵ take the deck' → '↵ start',
  // '· taking the deck' → '· starting') inked fewer hero cells, and the
  // settled hero now arrives at fill ≈0.0287 — the old threshold fell
  // INSIDE the trace growth, mis-anchoring arrival at frame 3-4 and
  // phantom-breaking all three laws downstream (LAW 1 froze trace ink as
  // hero ink; LAW 2 compared the settle against a mid-growth fill). The
  // pre-hero frames are exactly 0.0, so 0.02 still admits nothing early.
  const arrivalIdx = pf.findIndex(f => f.fill > 0.02)
  check('an arrival frame paints the hero', arrivalIdx >= 0 && arrivalIdx <= 2, `idx=${arrivalIdx}`)
  const arrival = pf[arrivalIdx]!
  const frames = pf.slice(arrivalIdx)

  // LAW 1 — hero permanence: every CELL the arrival frame's hero owns (its
  // non-space chars, minus the ready line the hold legitimately swaps for
  // the hint) renders the SAME char in every later frame. Whole-row equality
  // would be wrong — hero rows host legitimate traces in their free margins.
  const arrTxt = frameText(framesDir, arrival.i)
  const contentRows = arrTxt.map((l, r) => (l.trim().length > 0 ? r : -1)).filter(r => r >= 0)
  const heroRows = contentRows.slice(0, -1) // the last content row is the ready line
  const heroInk: Array<[number, number, string]> = []
  for (const r of heroRows) {
    const line = arrTxt[r] ?? ''
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== ' ') heroInk.push([r, c, line[c]!])
    }
  }
  let heroBroken: string | null = null
  for (const f of frames.slice(1)) {
    const txt = frameText(framesDir, f.i)
    for (const [r, c, ch] of heroInk) {
      if ((txt[r] ?? '')[c] !== ch) {
        heroBroken = `frame ${f.i} row ${r} col ${c}`
        break
      }
    }
    if (heroBroken) break
  }
  check('LAW 1: every hero cell char-identical across every frame', heroBroken === null,
    heroBroken ?? `${heroInk.length} cells held`)

  // LAW 2 — no blank frame after arrival.
  const minFill = Math.min(...frames.map(f => f.fill))
  check('LAW 2: no frame drops below the arrival fill', minFill >= arrival.fill * 0.95,
    `min=${minFill} arrival=${arrival.fill}`)

  // LAW 3 — bounded steps; the run ends settled (hero + hint ≈ arrival fill).
  let maxStep = 0
  for (let i = 1; i < frames.length; i++) maxStep = Math.max(maxStep, Math.abs(frames[i]!.fill - frames[i - 1]!.fill))
  check('LAW 3: no single-unit fill cliff (≤0.15)', maxStep <= 0.15, `maxStep=${maxStep.toFixed(3)}`)
  const last = frames[frames.length - 1]!
  check('LAW 3: the final frame is the settled hero (+hint)', last.fill <= arrival.fill + 0.03,
    `last=${last.fill} arrival=${arrival.fill}`)
  const lastTxt = frameText(framesDir, last.i)
  check('LAW 3: the hold hint stands on the settled scene', lastTxt.some(l => l.includes('starting…')))

  // LAW 4 — cadence over the trace window (arrival → peak), synced units.
  const peakIdx = frames.reduce((m, f, i) => (f.fill > frames[m]!.fill ? i : m), 0)
  const traceTs = frames.slice(0, peakIdx + 1).filter(f => f.synced).map(f => f.t)
  const deltas = traceTs.slice(1).map((t, i) => t - traceTs[i]!)
  const sorted = [...deltas].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  check('LAW 4: synced cadence p95 ≤ 40ms', deltas.length > 20 && p95 <= 40, `p95=${p95} n=${deltas.length}`)
  check('LAW 4: no starvation gap in the trace (≤150ms)', Math.max(...deltas) <= 150, `max=${Math.max(...deltas)}`)

  // LAW 7 — fill balance at the peak: no dead ninth, class-band coverage.
  const peak = frames[peakIdx]!
  const regs = peak.regions.flat()
  const mean = regs.reduce((a, b) => a + b, 0) / regs.length
  check('LAW 7: no dead ninth at peak (min ≥ 0.4×mean)', Math.min(...regs) >= 0.4 * mean,
    `min=${Math.min(...regs)} mean=${mean.toFixed(3)}`)
  check('LAW 7: peak fill in the ordinary-class band [0.25, 0.45]', peak.fill >= 0.25 && peak.fill <= 0.45,
    `peak=${peak.fill}`)
}

// ── the mid-trace shrink (LAW 5) ────────────────────────────────────────────
{
  const { report, framesDir, raw, exit } = cell('reseat', 120, 38, ['--resize', '800:80x24'])
  check('LAW 5: the resized run still hands off (exit 0)', exit === 0, `exit=${exit}`)
  const pf = report.per_frame
  const post = pf.filter(f => f.cols === 80)
  check('LAW 5: the run CONTINUES after the resize (≥20 more units)', post.length >= 20, `post=${post.length}`)
  // No addressed write beyond the new grid after the resize settles (the
  // 60ms debounce window is the resize handler's own contract).
  const rawStr = raw.toString('latin1')
  const marker = rawStr.slice(Math.floor(rawStr.length * 0.4)) // the post-resize majority
  let oob = 0
  for (const m of marker.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
    if (Number(m[1]) > 24 || Number(m[2]) > 80) oob++
  }
  check('LAW 5: zero out-of-bounds addressed writes after the reseat', oob === 0, `oob=${oob}`)
  const last = pf[pf.length - 1]!
  const lastTxt = frameText(framesDir, last.i)
  check('LAW 5: converges to the settled hero + hint at the new geometry',
    lastTxt.some(l => l.includes('(>_)')) && lastTxt.some(l => l.includes('starting…')))
}

// ── reduced motion (LAW 6) ──────────────────────────────────────────────────
{
  const { framesDir, report, raw, exit } = cell('reduced', 120, 38, ['--env', 'MERCURY_REDUCED_MOTION=1'])
  check('LAW 6: reduced motion hands off (exit 0)', exit === 0, `exit=${exit}`)
  const rawStr = raw.toString('utf8')
  check('LAW 6: no trace bytes (code glyphs absent)', !['{', '};', '=>', '();'].some(g => rawStr.includes(g)))
  const last = report.per_frame[report.per_frame.length - 1]!
  const lastTxt = frameText(framesDir, last.i)
  check('LAW 6: the hero holds (word art + hint on the final frame)',
    lastTxt.some(l => l.includes('█')) && lastTxt.some(l => l.includes('starting…')))
  check('LAW 6: bounded wall time (≤2s)', last.t <= 2000, `t=${last.t}`)
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n❌ prove-splash-choreography — ${failures} law(s) broken`)
  process.exit(1)
}
console.log('\n✅ prove-splash-choreography — the one-scene motion laws hold')
