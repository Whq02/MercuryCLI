#!/usr/bin/env bun

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

{
  const { report, framesDir, exit } = cell('natural', 120, 38)
  check('natural run hands off (exit 0)', exit === 0, `exit=${exit}`)
  const pf = report.per_frame
  const arrivalIdx = pf.findIndex(f => f.fill > 0.02)
  check('an arrival frame paints the hero', arrivalIdx >= 0 && arrivalIdx <= 2, `idx=${arrivalIdx}`)
  const arrival = pf[arrivalIdx]!
  const frames = pf.slice(arrivalIdx)

  const arrTxt = frameText(framesDir, arrival.i)
  const contentRows = arrTxt.map((l, r) => (l.trim().length > 0 ? r : -1)).filter(r => r >= 0)
  const heroRows = contentRows.slice(0, -1)
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

  const minFill = Math.min(...frames.map(f => f.fill))
  check('LAW 2: no frame drops below the arrival fill', minFill >= arrival.fill * 0.95,
    `min=${minFill} arrival=${arrival.fill}`)

  let maxStep = 0
  for (let i = 1; i < frames.length; i++) maxStep = Math.max(maxStep, Math.abs(frames[i]!.fill - frames[i - 1]!.fill))
  check('LAW 3: no single-unit fill cliff (≤0.15)', maxStep <= 0.15, `maxStep=${maxStep.toFixed(3)}`)
  const last = frames[frames.length - 1]!
  check('LAW 3: the final frame is the settled hero (+hint)', last.fill <= arrival.fill + 0.03,
    `last=${last.fill} arrival=${arrival.fill}`)
  const lastTxt = frameText(framesDir, last.i)
  check('LAW 3: the hold hint stands on the settled scene', lastTxt.some(l => l.includes('starting…')))

  const peakIdx = frames.reduce((m, f, i) => (f.fill > frames[m]!.fill ? i : m), 0)
  const traceTs = frames.slice(0, peakIdx + 1).filter(f => f.synced).map(f => f.t)
  const deltas = traceTs.slice(1).map((t, i) => t - traceTs[i]!)
  const sorted = [...deltas].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  check('LAW 4: synced cadence p95 ≤ 40ms', deltas.length > 20 && p95 <= 40, `p95=${p95} n=${deltas.length}`)
  check('LAW 4: no starvation gap in the trace (≤150ms)', Math.max(...deltas) <= 150, `max=${Math.max(...deltas)}`)

  const peak = frames[peakIdx]!
  const regs = peak.regions.flat()
  const mean = regs.reduce((a, b) => a + b, 0) / regs.length
  check('LAW 7: no dead ninth at peak (min ≥ 0.4×mean)', Math.min(...regs) >= 0.4 * mean,
    `min=${Math.min(...regs)} mean=${mean.toFixed(3)}`)
  check('LAW 7: peak fill in the ordinary-class band [0.25, 0.45]', peak.fill >= 0.25 && peak.fill <= 0.45,
    `peak=${peak.fill}`)
}

{
  const { report, framesDir, raw, exit } = cell('reseat', 120, 38, ['--resize', '800:80x24'])
  check('LAW 5: the resized run still hands off (exit 0)', exit === 0, `exit=${exit}`)
  const pf = report.per_frame
  const post = pf.filter(f => f.cols === 80)
  check('LAW 5: the run CONTINUES after the resize (≥20 more units)', post.length >= 20, `post=${post.length}`)
  const rawStr = raw.toString('latin1')
  const marker = rawStr.slice(Math.floor(rawStr.length * 0.4))
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
