#!/usr/bin/env bun
// ============================================================================
//  drive-live-tiles-ab — the A/B: with NO live sessions
//  the board is BYTE-IDENTICAL to the base dist's board.
//
//  Two hermetic boots per size (base dist via MERCURY_TILES_BASE_DIST, then
//  this tree's dist), no daemon, no sessions, MERCURY_LIVE_GLYPHS=0 (the
//  frame-0 statics both sides — a display gate, equal on both). The settled
//  frames compare row-by-row after normalizing exactly two lawful stamps:
//  the arena's own cwd slug and the header clock. ANY other differing row
//  is a failure and prints.
// ============================================================================
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE_DIST = process.env.MERCURY_TILES_BASE_DIST
if (!BASE_DIST || !existsSync(BASE_DIST)) {
  console.error('✗ MERCURY_TILES_BASE_DIST must name the base dist/mercury.mjs')
  process.exit(2)
}
const TIP_DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(TIP_DIST)) {
  console.error('✗ dist/mercury.mjs missing')
  process.exit(2)
}
const KEEP_DIR = process.env.MERCURY_TILES_CAPTURE_DIR
process.env.MERCURY_CONCOURSE = 'always'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

const normalize = (rows: string[]): string[] =>
  rows.map(r =>
    r
      .replace(/\s+$/, '')
      .replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'flux-arena-cwd-X')
      .replace(/\b\d{2}:\d{2}:\d{2}\b/g, 'HH:MM:SS'),
  )

async function settledBoard(dist: string, cols: number, rows: number): Promise<string[]> {
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 12,
    cols,
    rows,
    keep: true,
    distPath: dist,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd])
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_LIVE_GLYPHS: '0',
      // The greeter's gaze letter-swaps and idle breath/sway are TIME
      // sampled — =0 pins the authored rest grid (registry: captures pin
      // =0) so the compare reads product bytes, not animation phase. Both
      // sides carry the same pins.
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_IDLE: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const [g] = grabScreens(run, cols, rows, [10000])
    return normalize(g!.rows)
  } finally {
    run.cleanup()
  }
}

/** The ONE signed difference (sheet line 5): the legend row advertises the
 *  bound `→ peek` key (the a11y print-or-atlas law) — a differing row pair
 *  is lawful exactly when removing ' · → peek' from the tip row makes the
 *  two rows equal AFTER the shed (the legend sheds tail-priority parts to
 *  fit, so the base row must CONTAIN every part the reduced tip row has). */
const legendLawful = (baseRow: string, tipRow: string): boolean => {
  if (!tipRow.includes('→ peek')) return false
  const tipParts = tipRow.split(' · ').map(p => p.trim()).filter(p => p.length > 0 && p !== '→ peek')
  const baseParts = new Set(baseRow.split(' · ').map(p => p.trim()))
  return tipParts.every(p => baseParts.has(p))
}

for (const size of [
  { cols: 120, rows: 40 },
  { cols: 100, rows: 30 },
]) {
  // CONTROL first: the SAME dist twice must compare clean — a dirty
  // control means the rig (animation phase, timing) lies, not the product.
  const ctrlA = await settledBoard(BASE_DIST, size.cols, size.rows)
  const ctrlB = await settledBoard(BASE_DIST, size.cols, size.rows)
  const ctrlDiffs: number[] = []
  for (let i = 0; i < Math.max(ctrlA.length, ctrlB.length); i++) {
    if ((ctrlA[i] ?? '') !== (ctrlB[i] ?? '')) ctrlDiffs.push(i)
  }
  check(`A/B ${size.cols}x${size.rows} CONTROL: base-vs-base compares clean`, ctrlDiffs.length === 0, `rows ${ctrlDiffs.join(',')}`)

  const base = await settledBoard(BASE_DIST, size.cols, size.rows)
  const tip = await settledBoard(TIP_DIST, size.cols, size.rows)
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    writeFileSync(join(KEEP_DIR, `ab-base-${size.cols}x${size.rows}.txt`), base.join('\n'))
    writeFileSync(join(KEEP_DIR, `ab-tip-${size.cols}x${size.rows}.txt`), tip.join('\n'))
  }
  const diffs: string[] = []
  let legendRows = 0
  const n = Math.max(base.length, tip.length)
  for (let i = 0; i < n; i++) {
    const b = base[i] ?? ''
    const t = tip[i] ?? ''
    if (b === t) continue
    if (legendLawful(b, t)) {
      legendRows++
      continue
    }
    diffs.push(`row ${i}:\n  base: ${JSON.stringify(b)}\n  tip:  ${JSON.stringify(t)}`)
  }
  check(
    `A/B ${size.cols}x${size.rows}: byte-identical except the ONE signed legend row (→ peek)`,
    diffs.length === 0 && legendRows <= 1,
    diffs.length > 0 ? `\n${diffs.slice(0, 6).join('\n')}` : `legend rows: ${legendRows}`,
  )
  const sane = base.some(r => r.includes('SESSIONS')) && tip.some(r => r.includes('SESSIONS'))
  check(`A/B ${size.cols}x${size.rows}: both sides painted the board (poison guard)`, sane)
}

console.log(failures === 0 ? '\ndrive-live-tiles-ab: BYTE-IDENTICAL HOLDS' : `\ndrive-live-tiles-ab: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
