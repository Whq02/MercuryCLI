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
//        stacked ghost (the operator's screenshot showed 2+). A geometry
//        UNDER THE VIEWPORT FLOOR (80×30 is under the 100-column floor)
//        settles to the floor's ONE line and ZERO station copies — the
//        ghost law there is that no station copy survives either.
//    G3  the repaint is THROUGH the clear law: each geometry change is
//        followed by a contained erase before the next settled frame (2J
//        count ≥ resize count), and the journey never leaves the alternate
//        screen (zero ?1049l — no main-screen flash, nothing ceded to
//        scrollback).
//    G4  the final grid is single: the furniture needle appears exactly
//        once, at the final geometry.
//    G5  ONE settle per geometry change: every quiet window after a change
//        carries exactly one contained erase — and a BURST (six WINCHes
//        80 ms apart, a drag ending where it started) is ONE storm: one
//        erase, at most one holding paint, never a stacked station.
//    G6  no ghost rows: not one line feed rides the alternate-screen bytes
//        after the first change (a bottom-row LF scrolls the buffer).
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
import { resetViewportFloorForTests, viewportFloorLine, viewportFloorLive } from '../../src/ink/viewportFloor.ts'

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
    argv: ['node', BIN],
    sends: [],
    total: 130,
    resizes: [
      { atTick: 45, cols: 80, rows: 30 }, // the fullscreen-exit shrink
      { atTick: 70, cols: 100, rows: 38 },
      { atTick: 90, cols: 120, rows: 44 },
      // THE BURST (a drag): six WINCHes 80 ms apart ending where they
      // started — one storm, one settle.
      { atMs: 21_000, cols: 110, rows: 40 },
      { afterPrevMs: 80, cols: 100, rows: 36 },
      { afterPrevMs: 80, cols: 90, rows: 32 },
      { afterPrevMs: 80, cols: 100, rows: 36 },
      { afterPrevMs: 80, cols: 110, rows: 40 },
      { afterPrevMs: 80, cols: 120, rows: 44 },
    ],
    out: gridPath,
    cwd: SCRATCH,
    readyText: [NEEDLE],
    stableTicks: 8,
  }
  /** The first three changes settle in their own quiet windows; the rest
   *  are the burst's events. */
  const SETTLED_CHANGES = 3
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
  // The change ticks are read from the stages themselves (the burst's
  // events fire at sub-tick moments the schedule only names in ms).
  const changeTicks = stages.map(s => s.untilTick)
  const bytesIn = (from: number, to: number | null): string =>
    Buffer.concat(frames.filter(f => f.tick >= from && (to === null || f.tick < to)).map(f => f.bytes)).toString('latin1')
  const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1
  const erasesAfterFirstResize = countOf(bytesIn(changeTicks[0] ?? 45, null), '\x1b[2J')
  check(
    'G3 every geometry change repaints THROUGH the clear law (erases ≥ settled changes)',
    erasesAfterFirstResize >= SETTLED_CHANGES + 1,
    `${erasesAfterFirstResize} erases for ${SETTLED_CHANGES} settled changes + one burst`,
  )

  // ── the frames: exactly ONE station copy at every geometry ───────────────
  // The viewport floor's latch is replayed through the settled geometries
  // in order (the same live owner the product ran): a geometry it calls
  // under settles to the floor's one line and no station at all.
  check('G2 stage snapshots recorded for every geometry', stages.length === cfg.resizes.length, `${stages.length}`)
  resetViewportFloorForTests()
  stages.forEach((stage, i) => {
    const n = needleCount(stage.grid)
    if (i < SETTLED_CHANGES) {
      const floor = viewportFloorLive(stage.cols, stage.rows)
      if (floor.fits) {
        check(
          `G2 geometry ${stage.cols}x${stage.rows} settled with EXACTLY ONE station frame (no ghost stack)`,
          n === 1,
          `${n} copies of ${JSON.stringify(NEEDLE)} before resize #${i + 1}`,
        )
      } else {
        const painted = stage.grid.map(rowText).filter(r => r.trim() !== '')
        check(
          `G2 geometry ${stage.cols}x${stage.rows} is under the floor: the one line, ZERO station copies`,
          n === 0 && painted.length === 1 && painted[0]!.trim() === viewportFloorLine(stage.cols, stage.rows),
          `${n} copies of ${JSON.stringify(NEEDLE)} · ${painted.length} painted row(s): ${JSON.stringify(painted[0]?.trim() ?? '')}`,
        )
      }
    } else {
      // Mid-storm the screen holds the last frame clipped to each
      // intermediate size: the needle may be clipped away, never doubled.
      check(`G5 burst event ${i - SETTLED_CHANGES + 1} (${stage.cols}x${stage.rows}) never stacks the station`, n <= 1, `${n} copies`)
    }
  })

  // ── G5: one settle per quiet window; the burst is ONE storm ─────────────
  // The quiet windows: [change0, change1), [change1, change2), [change2,
  // burst-start), [burst-start, end). Each carries exactly one erase.
  const burstStart = changeTicks[SETTLED_CHANGES]
  const windows: Array<[string, number, number | null]> = []
  for (let i = 0; i < SETTLED_CHANGES; i++) {
    const to = i + 1 < SETTLED_CHANGES ? changeTicks[i + 1]! : burstStart ?? null
    windows.push([`change ${i + 1} (${cfg.resizes[i]!.cols}x${cfg.resizes[i]!.rows})`, changeTicks[i]!, to])
  }
  if (burstStart !== undefined) windows.push(['the burst', burstStart, null])
  for (const [label, from, to] of windows) {
    const bytes = bytesIn(from, to)
    check(`G5 ${label}: exactly ONE contained erase in its window`, countOf(bytes, '\x1b[2J') === 1, `${countOf(bytes, '\x1b[2J')} erases`)
  }
  if (burstStart !== undefined) {
    const burst = bytesIn(burstStart, null)
    check('G5 the burst holds at most ONCE (one holding paint, not one per event)', countOf(burst, '\x1b[?25l') <= 1, `${countOf(burst, '\x1b[?25l')} holds`)
  }
  // ── G6: no ghost rows — no line feed rides the alt-screen bytes ─────────
  const afterFirst = bytesIn(changeTicks[0] ?? 45, null)
  check('G6 not one line feed after the first change (a bottom-row LF would scroll the buffer)', countOf(afterFirst, '\n') === 0, `${countOf(afterFirst, '\n')} line feeds`)
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
