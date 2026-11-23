#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cellColor, CRITTERS, EYE_BG } from '../../src/screen/cockpit/critterData.js'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const norm = (c: unknown): string => String(c ?? '').replace('#', '').toLowerCase()
const CREAM = norm(EYE_BG)
const PUPIL_HEX = norm(cellColor(CRITTERS[0]!, 'K'))

type GridCell = { c: string; fg: string; bg: string }
type Grid = { grid: GridCell[][] }

function capture(tag: string, sends: unknown[], settle: number): Grid {
  const cfg = scenario('resume-2turn', 120, 44)
  const out = `/tmp/gaze-live-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/gaze-live-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends, total: 150, cols: 120, rows: 44, out, readyText: '│❯', readySettleTicks: settle }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '..', 'ui', 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CRITTER_GAZE: '1',
      MERCURY_CRITTER_IDLE: '1',
      MERCURY_CRITTER: 'crab',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)} (the capture runs scripts/ui/vshot.py with /usr/bin/python3; read its stderr above)`)
  return JSON.parse(readFileSync(out, 'utf8')) as Grid
}

function eyeClusters(g: Grid): Array<{ cols: number[]; pupilCol: number }> {
  const clusters: Array<{ cols: number[]; pupilCol: number }> = []
  const rows = Math.min(14, g.grid.length)
  for (let y = 0; y < rows; y++) {
    const row = g.grid[y]!
    let run: number[] = []
    const flush = (): void => {
      if (run.length >= 2) {
        const pupil = run.find(x => norm(row[x]!.bg) === PUPIL_HEX || norm(row[x]!.fg) === PUPIL_HEX)
        if (pupil !== undefined) clusters.push({ cols: run, pupilCol: pupil })
      }
      run = []
    }
    for (let x = 0; x < row.length; x++) {
      const cell = row[x]!
      const cream =
        norm(cell.fg) === CREAM ||
        norm(cell.bg) === CREAM ||
        norm(cell.bg) === PUPIL_HEX ||
        norm(cell.fg) === PUPIL_HEX
      if (cream) run.push(x)
      else flush()
    }
    flush()
  }
  return clusters
}

function captureWithRetry(tag: string, sends: unknown[], settle: number): { g: Grid; eyes: Array<{ cols: number[]; pupilCol: number }> } {
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = capture(`${tag}-${attempt}`, sends, settle)
    const eyes = eyeClusters(g)
    if (eyes.length >= 2) return { g, eyes }
    console.log(`  (retry ${tag}: eye cells not found — likely a blink-lid frame)`)
  }
  throw new Error(`${tag}: no eye clusters after retry; the capture shows no cream eye cells with a pupil in the top 14 rows, so check eyeClusters in this file against the crab art in src/screen/cockpit/critterData.ts`)
}

console.log('============================================================')
console.log(' critter gaze — live binary, synthetic SGR motion')
console.log('============================================================')

try {
  const neutral = captureWithRetry('neutral', [], 15)
  t('neutral: ≥2 eye clusters found', neutral.eyes.length >= 2, `${neutral.eyes.length} eye clusters; the crab hero art must paint cream eye cells with a pupil in the top 14 rows (heroEyeClusters in src/screen/cockpit/critterGaze.ts, colors in src/screen/cockpit/critterData.ts)`)
  const neutralCentered = neutral.eyes.every(
    e => e.pupilCol !== e.cols[0] && e.pupilCol !== e.cols[e.cols.length - 1],
  )
  t('neutral: every pupil at its cluster center (authored pose)', neutralCentered,
    `with no pointer motion the pupils must stay at the authored centre pose (applyGazeKey and heroGazeRows in src/screen/cockpit/critterGaze.ts) · ${neutral.eyes.map(e => `${e.pupilCol}∈[${e.cols[0]}..${e.cols[e.cols.length - 1]}]`).join(' ')}`)

  const moved = captureWithRetry('left', [
    { requireAwait: true, awaitText: '│❯', minTick: 5, awaitSettleTicks: 10, data: '\x1b[<35;40;20M' },
    { afterPrevTicks: 2, data: '\x1b[<35;15;8M' },
    { afterPrevTicks: 2, data: '\x1b[<35;3;4M' },
  ], 10)
  t('left-gaze: ≥2 eye clusters found', moved.eyes.length >= 2, `${moved.eyes.length} eye clusters; the crab hero art must paint cream eye cells with a pupil in the top 14 rows (heroEyeClusters in src/screen/cockpit/critterGaze.ts, colors in src/screen/cockpit/critterData.ts)`)
  const allLeft = moved.eyes.every(e => e.pupilCol === e.cols[0])
  t('left-gaze: every pupil at its cluster LEFT cell (tracked the pointer)', allLeft,
    `after the pointer moves to the far left the pupils must move to the left cell of each eye (gazeKeyForPointer and applyGazeKey in src/screen/cockpit/critterGaze.ts; needs MERCURY_CRITTER_GAZE on, critterGazeEnabled) · ${moved.eyes.map(e => `${e.pupilCol}∈[${e.cols[0]}..${e.cols[e.cols.length - 1]}]`).join(' ')}`)
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures ? '\n❌ GAZE-LIVE RED' : '\n✅ GAZE-LIVE GREEN')
process.exit(failures)
