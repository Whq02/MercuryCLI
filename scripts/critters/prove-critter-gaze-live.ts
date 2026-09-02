#!/usr/bin/env bun
// ============================================================================
//  prove-critter-gaze-live — the mouse-tracking gaze through the REAL binary.
//
//  Two PTY captures of the resume-2turn cockpit (120×44, crab hero at the
//  transcript top): a NEUTRAL boot, and a boot that receives a synthetic SGR
//  any-motion trail ending far LEFT of the mascot at eye height. The whole
//  wiring is under test: stdin bytes → parse-keypress → handleMouseEvent →
//  pointerCell store → AnimatedCritterArt subscription → nodeCache rect →
//  gazeKeyForPointer → CritterArt letter swap → half-block colors.
//
//  Assertions are COLOR-anchored and cluster-relative (position-independent):
//  the crab's eye row renders 3 cream-fg cells per eye; the pupil is the one
//  whose BACKGROUND is the near-black pupil mix. Neutral ⇒ pupil at the
//  cluster CENTER (authored EKE); left-gaze ⇒ pupil at the cluster's LEFT
//  cell. A capture that lands on a blink lid (~4% odds: no cream cells at
//  all) retries once — two coincident lids ≈ 0.2%.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cellColor, CRITTERS, EYE_BG } from '../../src/utils/cockpit/critterData.js'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const norm = (c: unknown): string => String(c ?? '').replace('#', '').toLowerCase()
const CREAM = norm(EYE_BG)
// The crab hero pupil — read through the PRODUCTION mapping (cellColor 'K'),
// so a future darken-ratio tweak can't silently strand this needle.
const PUPIL_HEX = norm(cellColor(CRITTERS[0]!, 'K'))

type GridCell = { c: string; fg: string; bg: string }
type Grid = { grid: GridCell[][] }

function capture(tag: string, sends: Array<{ atTick: number; data: string }>, total = 55): Grid {
  const cfg = scenario('resume-2turn', 120, 44)
  const out = `/tmp/gaze-live-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/gaze-live-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends, total, cols: 120, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '..', 'ui', 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      // The scenario pin turns gaze OFF for hermeticity — this leg is the
      // dedicated re-enable. Gaze RIDES the idle animate schedule, and the
      // R7 close pinned MERCURY_CRITTER_IDLE=0 for every capture (the hermit
      // blink broke byte-silence) — so this leg re-enables BOTH.
      MERCURY_CRITTER_GAZE: '1',
      MERCURY_CRITTER_IDLE: '1',
      // Deterministic shape: pin the crab (the PUPIL_HEX needle and the
      // eye-cluster geometry below are the CRAB's authored facts — the unset
      // default is octopus, and an operator's persisted /critter pick must
      // not move this capture either; same pin as prove-berth-hero).
      MERCURY_CRITTER: 'crab',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)}`)
  return JSON.parse(readFileSync(out, 'utf8')) as Grid
}

/** Find the crab's eye clusters on screen: horizontal runs of cream cells
 *  that CONTAIN a pupil-colored background. The pupil requirement is the
 *  discriminator — IVORY text (the same hex as the eye cream, by design)
 *  forms cream runs all over the chrome, but only a real eye carries the
 *  critter-specific near-black pupil mix. Scans the hero region (top rows). */
function eyeClusters(g: Grid): Array<{ cols: number[]; pupilCol: number }> {
  const clusters: Array<{ cols: number[]; pupilCol: number }> = []
  const rows = Math.min(14, g.grid.length)
  for (let y = 0; y < rows; y++) {
    const row = g.grid[y]!
    let run: number[] = []
    const flush = (): void => {
      if (run.length >= 2) {
        const pupil = run.find(x => norm(row[x]!.bg) === PUPIL_HEX)
        if (pupil !== undefined) clusters.push({ cols: run, pupilCol: pupil })
      }
      run = []
    }
    for (let x = 0; x < row.length; x++) {
      const cell = row[x]!
      const cream =
        norm(cell.fg) === CREAM ||
        norm(cell.bg) === CREAM ||
        norm(cell.bg) === PUPIL_HEX
      if (cream) run.push(x)
      else flush()
    }
    flush()
  }
  return clusters
}

function captureWithRetry(tag: string, sends: Array<{ atTick: number; data: string }>, total = 55): { g: Grid; eyes: Array<{ cols: number[]; pupilCol: number }> } {
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = capture(`${tag}-${attempt}`, sends, total)
    const eyes = eyeClusters(g)
    if (eyes.length >= 2) return { g, eyes }
    console.log(`  (retry ${tag}: eye cells not found — likely a blink-lid frame)`)
  }
  throw new Error(`${tag}: no eye clusters after retry`)
}

console.log('============================================================')
console.log(' critter gaze — live binary, synthetic SGR motion')
console.log('============================================================')

try {
  // NEUTRAL: no pointer → authored EKE → pupil at the cluster CENTER.
  const neutral = captureWithRetry('neutral', [])
  t('neutral: ≥2 eye clusters found', neutral.eyes.length >= 2, `${neutral.eyes.length}`)
  const neutralCentered = neutral.eyes.every(
    e => e.pupilCol !== e.cols[0] && e.pupilCol !== e.cols[e.cols.length - 1],
  )
  t('neutral: every pupil at its cluster center (authored pose)', neutralCentered,
    neutral.eyes.map(e => `${e.pupilCol}∈[${e.cols[0]}..${e.cols[e.cols.length - 1]}]`).join(' '))

  // LEFT-GAZE: an any-motion trail (button 35 = 32+3) ending far left of the
  // mascot at eye height. 1-indexed SGR coords.
  // TOTAL 42, NOT 55: the gaze WALKS HOME after ~6s of pointer stillness
  // (product law — the pointer store's idle emit). The movie scale
  // stretches ticks but not that wall-clock timer, so a long tail after
  // the last send lawfully reverts the pupils before the final frame
  // (run 3: centered pupils at scale 3, the known residual class). Four
  // trailing ticks = 0.8s at scale 1, 2.4s nominal at scale 3 — always
  // inside the 6s window, and the gaze applies on the pointer edge itself.
  const moved = captureWithRetry('left', [
    { atTick: 34, data: '\x1b[<35;40;20M' },
    { atTick: 36, data: '\x1b[<35;15;8M' },
    { atTick: 38, data: '\x1b[<35;3;4M' },
  ], 42)
  t('left-gaze: ≥2 eye clusters found', moved.eyes.length >= 2, `${moved.eyes.length}`)
  const allLeft = moved.eyes.every(e => e.pupilCol === e.cols[0])
  t('left-gaze: every pupil at its cluster LEFT cell (tracked the pointer)', allLeft,
    moved.eyes.map(e => `${e.pupilCol}∈[${e.cols[0]}..${e.cols[e.cols.length - 1]}]`).join(' '))
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures ? '\n❌ GAZE-LIVE RED' : '\n✅ GAZE-LIVE GREEN')
process.exit(failures)
