#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-rail-click-after-resize.ts — WHAT YOU SEE IS WHAT YOU
//  CLICK: pointer hit-targets match the painted frame, including after a
//  terminal resize in BOTH directions, in TWO worlds:
//
//    · deployed-default — 120x40, the plain xterm-family write path;
//    · apple-terminal — the operator's live shape (TERM_PROGRAM=
//      Apple_Terminal at 128×36): Apple Terminal has NO synchronized
//      output (the DECRQM 2026 probe is suppressed there and the sniff
//      never arms it), so every frame rides the UNBRACKETED write path;
//      the ambient animations (clock · critter · ready-breath) keep
//      commits landing while resize storms settle. (The operator's
//      six-live-lanes population needs a live daemon crew — outside a
//      lane rig; the geometry/write-path/storm ingredients are all here.)
//
//  The operator's live-cockpit class this hunts: after a resize,
//  clicking/hovering a rail row only registered when the pointer sat LOWER
//  than the painted row — a hit plane one band off the paint.
//
//  Each world: boot → face-↵ → focus-in, then click the TABULA notes row
//  at its PAINTED coordinates (vshot targetText resolves {X}/{Y} against
//  the LIVE grid at fire time), SHRINK and click minerva, GROW and click
//  notes, drag-STORM (four WINCHes, settling on a fifth geometry) and
//  click minerva. Registration = the rail caret claims the clicked row.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-rail-click-after-resize.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = join(import.meta.dir, '../..')
const SCRATCH = `/tmp/mercury-rail-click-${process.pid}`

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
const rowText = (grid: Grid, r: number): string => (grid[r] ?? []).map(c => c.c).join('')

/** The full text of the row containing `needle`, or null. */
function rowWith(grid: Grid, needle: string): string | null {
  for (let r = 0; r < grid.length; r++) {
    const text = rowText(grid, r)
    if (text.includes(needle)) return text
  }
  return null
}

/** The rail caret claim: the row holding `needle` leads with the ❯ caret
 *  AT COLUMN 0 — the selection caret's berth. (The minerva row's own glyph
 *  is ❯ too, indented; a trimmed prefix test false-positives on it.) */
function caretOn(grid: Grid, needle: string): boolean {
  const text = rowWith(grid, needle)
  return text !== null && text.startsWith('❯')
}

type Shape = {
  tag: string
  cols: number
  rows: number
  shrink: { cols: number; rows: number }
  grow: { cols: number; rows: number }
  storm: Array<{ cols: number; rows: number }>
  env: Record<string, string>
}
const SHAPES: Shape[] = [
  {
    tag: 'deployed-default',
    cols: 120, rows: 40,
    shrink: { cols: 120, rows: 32 },
    grow: { cols: 120, rows: 48 },
    storm: [
      { cols: 120, rows: 44 }, { cols: 110, rows: 36 },
      { cols: 124, rows: 42 }, { cols: 116, rows: 38 },
    ],
    env: {},
  },
  {
    tag: 'apple-terminal',
    // The operator's screenshot geometry, and Apple Terminal's env shape:
    // TERM_PROGRAM selects the no-sync-output write path and the
    // DECRQM-suppression branch in OUR code (pyte hosts the bytes).
    cols: 128, rows: 36,
    shrink: { cols: 128, rows: 30 },
    grow: { cols: 128, rows: 44 },
    storm: [
      { cols: 128, rows: 40 }, { cols: 118, rows: 32 },
      { cols: 132, rows: 38 }, { cols: 122, rows: 33 },
    ],
    env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color', TERM_PROGRAM_VERSION: '455' },
  },
]

// A left-button SGR click (press+release at the resolved cell).
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
// Tick geography per shape run (200ms ticks — generous settle margins).
const SHRINK_AT = 70
const GROW_AT = 110
const STORM_AT = 140

mkdirSync(SCRATCH, { recursive: true })

for (const shape of SHAPES) {
  console.log(`\n── shape: ${shape.tag} (${shape.cols}x${shape.rows})`)
  const home = join(SCRATCH, `home-${shape.tag}`)
  mkdirSync(home, { recursive: true })
  seedFirstRun(home, [ROOT])

  const out = join(SCRATCH, `${shape.tag}.json`)
  const cfg = {
    argv: ['node', join(ROOT, 'dist/mercury.mjs')],
    cols: shape.cols, rows: shape.rows, total: 250,
    out,
    resizes: [
      { atTick: SHRINK_AT, ...shape.shrink },
      { atTick: GROW_AT, ...shape.grow },
      // The STORM: a drag-resize burst — consecutive WINCHes across sizes,
      // settling at a size DIFFERENT from every intermediate.
      ...shape.storm.map((s, i) => ({ atTick: STORM_AT + i, ...s })),
    ],
    sends: [
      { atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' },
      { atTick: 999, requireAwait: true, awaitText: 'shortcuts', minTick: 4, awaitSettleTicks: 8, data: '\x1b[I', mark: 'chat' },
      // WARMUP — one unasserted click: if the focus event has not landed
      // yet, the refocus law swallows exactly this press (focus-only), so
      // every ASSERTED click below meets a focused terminal.
      { atTick: 999, requireAwait: true, awaitText: 'ask minerva', minTick: 2, awaitSettleTicks: 3, targetText: 'ask minerva', data: CLICK, mark: 'warmup' },
      // PHASE 1 — pre-resize click on the TABULA notes row.
      { atTick: 999, requireAwait: true, awaitText: 'no notes', minTick: 2, awaitSettleTicks: 3, targetText: 'no notes', data: CLICK, mark: 'click1' },
      // Observed-ready: the after-marks WAIT FOR the caret claim itself —
      // a slow paint under load is waited out; a dead click never
      // satisfies the await and reds as an UNDELIVERED send by name.
      { atTick: 999, requireAwait: true, awaitText: '❯ ✧ no notes', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after1' },
      // PHASE 2 — post-SHRINK click at the newly painted coordinates.
      { atTick: 999, requireAwait: true, awaitText: 'ask minerva', minTick: SHRINK_AT + 3, awaitSettleTicks: 3, targetText: 'ask minerva', data: CLICK, mark: 'click2' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ❯ ask minerva', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after2' },
      // PHASE 3 — post-GROW click back on the notes row.
      { atTick: 999, requireAwait: true, awaitText: 'no notes', minTick: GROW_AT + 3, awaitSettleTicks: 3, targetText: 'no notes', data: CLICK, mark: 'click3' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ✧ no notes', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after3' },
      // PHASE 4 — after the drag STORM settles, click minerva at the
      // freshly painted coordinates of the final geometry.
      { atTick: 999, requireAwait: true, awaitText: 'ask minerva', minTick: STORM_AT + 6, awaitSettleTicks: 3, targetText: 'ask minerva', data: CLICK, mark: 'click4' },
      { atTick: 999, requireAwait: true, awaitText: '❯ ❯ ask minerva', minTick: 1, awaitSettleTicks: 2, data: '', mark: 'after4' },
    ],
  }
  const cfgPath = join(SCRATCH, `${shape.tag}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(420000), cwd: ROOT,
    // The deck companion stays at its DEFAULT-ON state — its band is part
    // of the live cockpit's row geometry. The boot carries the canonical
    // fixture credential (the seed approves it): a keyless home's New
    // Session is REFUSED at the daemon's admission ("model refused
    // (no-credential:anthropic)" in the face footer) and every later send
    // stays undelivered — the CI job's ambient ANTHROPIC_API_KEY masked
    // this on the hosted gate; a quiet box has none. The drive never sends
    // a prompt, so the key is never spent.
    env: { ...process.env, MERCURY_FULLSCREEN: '1', MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: FIXTURE_API_KEY, ...shape.env },
  })
  check(`${shape.tag}: drive exits 0`, res.status === 0, `status ${res.status}: ${(res.stdout ?? '').slice(-500)}`)
  const undelivered = /UNDELIVERED-SENDS/.test(res.stdout ?? '')
  check(`${shape.tag}: every send became due (clicks resolved on the live grid)`, !undelivered,
    (res.stdout ?? '').split('\n').filter(l => l.includes('UNDELIVERED')).join(' '))
  if (res.status !== 0 || undelivered) continue

  const payload = JSON.parse(readFileSync(out, 'utf-8')) as { marks: Mark[] }
  const mark = (label: string): Mark | undefined => payload.marks.find(m => m.label === label)
  const after1 = mark('after1')
  const after2 = mark('after2')
  const after3 = mark('after3')
  const after4 = mark('after4')
  const click2 = mark('click2')

  // Tick geography holds: phase 1 closed before the shrink; phase 2 fired
  // after it and closed before the grow.
  check(`${shape.tag}: phase 1 closed before the shrink`, (after1?.atTick ?? 999) < SHRINK_AT, `after1 @${after1?.atTick}`)
  check(`${shape.tag}: phase 2 fired after the shrink and closed before the grow`,
    (click2?.atTick ?? 0) > SHRINK_AT && (after2?.atTick ?? 999) < GROW_AT,
    `click2 @${click2?.atTick} after2 @${after2?.atTick}`)

  // PHASE 1 — the pre-resize click claims the row.
  check(`${shape.tag}: pre-resize click claims the notes row`,
    after1 !== undefined && caretOn(after1.grid, 'no notes'),
    after1 ? JSON.stringify(rowWith(after1.grid, 'no notes')) : 'no after1 mark')

  // PHASE 2 — after the SHRINK, the click at the NEW painted coordinates
  // claims the minerva row (and releases the notes row).
  check(`${shape.tag}: post-shrink click claims the minerva row`,
    after2 !== undefined && caretOn(after2.grid, 'ask minerva'),
    after2 ? JSON.stringify(rowWith(after2.grid, 'ask minerva')) : 'no after2 mark')
  check(`${shape.tag}: post-shrink the notes row released the caret`,
    after2 !== undefined && !caretOn(after2.grid, 'no notes'),
    after2 ? JSON.stringify(rowWith(after2.grid, 'no notes')) : 'no after2 mark')

  // PHASE 3 — after the GROW, the click comes back to the notes row.
  check(`${shape.tag}: post-grow click claims the notes row again`,
    after3 !== undefined && caretOn(after3.grid, 'no notes'),
    after3 ? JSON.stringify(rowWith(after3.grid, 'no notes')) : 'no after3 mark')
  check(`${shape.tag}: post-grow the minerva row released the caret`,
    after3 !== undefined && !caretOn(after3.grid, 'ask minerva'),
    after3 ? JSON.stringify(rowWith(after3.grid, 'ask minerva')) : 'no after3 mark')

  // PHASE 4 — after the drag storm, the click at the final geometry's
  // painted coordinates claims minerva.
  check(`${shape.tag}: post-storm click claims the minerva row`,
    after4 !== undefined && caretOn(after4.grid, 'ask minerva'),
    after4 ? JSON.stringify(rowWith(after4.grid, 'ask minerva')) : 'no after4 mark')
  check(`${shape.tag}: post-storm the notes row released the caret`,
    after4 !== undefined && !caretOn(after4.grid, 'no notes'),
    after4 ? JSON.stringify(rowWith(after4.grid, 'no notes')) : 'no after4 mark')

}

if (failures > 0) {
  console.log(`\nrail click after resize: RED (${failures}/${checks}) — artifacts at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nrail click after resize: green (${checks} checks)`)
