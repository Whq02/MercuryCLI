#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-resize-ghost.ts — the CLEAR/DAMAGE law on a
//  geometry change, driven through the REAL binary (operator repro:
//  leaving macOS fullscreen during the first-run walk
//  re-painted WITHOUT erasing — the walk stacked duplicate copies into
//  scrollback and kept duplicating on further geometry changes).
//
//  The fix under proof: boot stations (the first-run walk included) ride the
//  fullscreen surface policy — they mount inside the alternate screen, where
//  a resize repaints through the alt clear/damage law (a contained [2J +
//  full repaint) and the main screen's scrollback never receives a frame.
//
//  LEGS (one PTY journey, a VIRGIN config home, the walk's theme station):
//    G1  the walk paints INSIDE the alternate screen (the ghost class needs
//        the main screen; alt has no scrollback to pollute) — and not one
//        walk byte lands on the main screen BEFORE the alt entry.
//    G2  a fullscreen-exit-sized shrink (150→80) and two more geometry
//        changes (80→100, 100→120): after EVERY change the settled frame
//        carries EXACTLY ONE copy of the station's furniture — never a
//        stacked ghost (the operator's screenshot showed 2+).
//    G3  the repaint is THROUGH the clear law: each geometry change is
//        followed by a contained erase before the next settled frame (2J
//        count ≥ resize count), and the journey never leaves the alternate
//        screen (zero ?1049l — no main-screen flash, nothing ceded to
//        scrollback).
//    G4  the final grid is single: the furniture needle appears exactly
//        once, at the final geometry.
//
//  DETECTOR SCOPE (bite-checked): pyte neither rewraps nor keeps scrollback,
//  so the INLINE ghost class (main-screen rewrap duplication) is asserted
//  structurally — G1 goes red the moment the walk paints outside the alt
//  screen (verified: MERCURY_FULLSCREEN=0 yields zero alt entries). G2/G4
//  catch the ALT-side ghost class directly: a repaint that skips the erase
//  leaves the stale station rows in the pyte viewport as extra needles.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')

if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — build first (bun run build.ts)')
  process.exit(1)
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// The station furniture needle: the theme station's first offered row is
// authored in Onboarding.tsx's THEME_ROWS (the reachable-theme vocabulary).
// One copy on screen = one frame; two = the operator's ghost stack.
const NEEDLE = 'Oasis dark'

type Cell = { c: string }
type Grid = { grid: Cell[][] }
type Stage = { cols: number; rows: number; untilTick: number; grid: Cell[][] }

function rowText(row: Cell[]): string {
  return row.map(c => c.c).join('')
}
function needleCount(grid: Cell[][]): number {
  return grid.filter(row => rowText(row).includes(NEEDLE)).length
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'resize-ghost-'))
const CONFIG_HOME = join(SCRATCH, 'home') // VIRGIN — the walk must show
const gridPath = join(SCRATCH, 'walk.grid.json')
const teePath = join(SCRATCH, 'walk.tee.bin')

console.log('resize-ghost — the clear/damage law on the first-run walk (real binary)')
try {
  const cfg = {
    cols: 150,
    rows: 44,
    total: 120,
    argv: ['node', BIN],
    sends: [],
    resizes: [
      { atTick: 45, cols: 80, rows: 30 }, // the fullscreen-exit shrink
      { atTick: 70, cols: 100, rows: 38 },
      { atTick: 90, cols: 120, rows: 44 },
    ],
    out: gridPath,
    cwd: SCRATCH,
    readyText: [NEEDLE],
    stableTicks: 8,
  }
  const cfgPath = join(SCRATCH, 'walk.cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    VSHOT_TEE: teePath,
  }
  delete env.VSHOT_ACTIVE
  delete env.MERCURY_FULLSCREEN // unset = the fullscreen default (the policy under proof)
  delete env.MERCURY_ALT_HELD
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { env, timeout: vshotBudgetMs(180_000), stdio: 'pipe' })
  check('the walk journey captured (vshot exit 0)', res.status === 0, res.stderr?.toString().slice(-300) ?? '')
  if (res.status !== 0) throw new Error('capture failed')

  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid & { stages?: Stage[] }
  const stages = payload.stages ?? []

  // ── the tee: alt-screen discipline over the whole journey ────────────────
  const tee = readFileSync(teePath)
  const frames: Array<{ tick: number; bytes: Buffer }> = []
  let off = 0
  while (off + 8 <= tee.length) {
    const tick = tee.readUInt32BE(off)
    const len = tee.readUInt32BE(off + 4)
    off += 8
    frames.push({ tick, bytes: tee.subarray(off, off + len) })
    off += len
  }
  const all = Buffer.concat(frames.map(f => f.bytes)).toString('latin1')
  const altEnterAt = all.indexOf('\x1b[?1049h')
  check('G1 the walk enters the alternate screen (the station host)', altEnterAt >= 0)
  check(
    'G1 not one walk byte on the main screen before the alt entry (scrollback purity)',
    altEnterAt >= 0 && !all.slice(0, altEnterAt).includes(NEEDLE),
  )
  const exits = (all.match(/\x1b\[\?1049l/g) ?? []).length
  check('G3 the journey never leaves the alt screen (zero ?1049l)', exits === 0, `${exits} exits`)

  // Erases AFTER each resize: the alt resize law is a contained [2J +
  // full repaint. Count 2J occurrences after the first resize's tick.
  const resizeTicks = cfg.resizes.map(r => r.atTick)
  const erasesAfterFirstResize = frames
    .filter(f => f.tick >= resizeTicks[0]!)
    .reduce((n, f) => n + (f.bytes.toString('latin1').match(/\x1b\[2J/g) ?? []).length, 0)
  check(
    'G3 every geometry change repaints THROUGH the clear law (erases ≥ resizes)',
    erasesAfterFirstResize >= cfg.resizes.length,
    `${erasesAfterFirstResize} erases for ${cfg.resizes.length} resizes`,
  )

  // ── the frames: exactly ONE station copy at every geometry ───────────────
  check('G2 stage snapshots recorded for every geometry', stages.length === cfg.resizes.length, `${stages.length}`)
  stages.forEach((stage, i) => {
    const n = needleCount(stage.grid)
    check(
      `G2 geometry ${stage.cols}x${stage.rows} settled with EXACTLY ONE station frame (no ghost stack)`,
      n === 1,
      `${n} copies of ${JSON.stringify(NEEDLE)} before resize #${i + 1}`,
    )
  })
  const finalCount = needleCount(payload.grid)
  check('G4 the final grid is single (one station frame at the final geometry)', finalCount === 1, `${finalCount} copies`)
  check(
    'G4 the final geometry is the commanded one',
    payload.grid.length === 44 && payload.grid[0]!.length === 120,
    `${payload.grid[0]?.length}x${payload.grid.length}`,
  )
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n❌ ${failures} RESIZE-GHOST PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL RESIZE-GHOST PROOFS PASS')
