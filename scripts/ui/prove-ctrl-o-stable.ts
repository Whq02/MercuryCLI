#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-ctrl-o-stable.ts — the transcript-toggle STABILITY
//  oracle.
//
//  ctrl+o would otherwise swap between two DIFFERENT return trees (FullscreenLayout
//  at different slots/depths — the main one inside MCPConnectionManager,
//  the transcript one bare), so React positionally unmounted+remounted
//  FullscreenLayout/ScrollBox/VirtualMessageList/every MessageRow BOTH
//  directions (867 creates per toggle commit measured pre-fix, vs 768 at
//  boot), remounted the MCP provider (a full rescan per toggle), and
//  destroyed the scroll position. After the one-skeleton unification the
//  toggle is a PROPS change.
//
//  Note on metrics: raw creates= cannot separate identity loss from the
//  verbose flip legitimately rendering MORE content per surviving row, so
//  this proof asserts the user-meaningful invariants directly:
//
//    A. STRUCTURE (text pins): ONE FullscreenLayout and ONE
//       MCPConnectionManager in REPL.tsx — no transcript twin exists to
//       positionally swap against; the legacy dump branch has neither.
//    B. SCROLL POSITION SURVIVES THE ROUND-TRIP (PTY grids): scroll up in
//       the transcript, then ctrl+o out and back in — the visible rows
//       equal the scrolled view (pre-fix: ScrollBox remounted, position
//       reset to bottom).
//    C. full-damage frames across both toggles stay bounded.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-ctrl-o-stable.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_HOME, writeSyntheticSession, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const BIN = join(ROOT, 'dist', 'mercury.mjs')
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-ctrl-o-stable')

// ── A. structure pins ────────────────────────────────────────────────────────
{
  const repl = readFileSync(join(ROOT, 'src', 'screens', 'REPL.tsx'), 'utf8')
  // Mount syntax may be single- or multi-line: match the tag name followed
  // by any JSX delimiter, not a literal space (the pin went stale when the
  // mount gained enough props to wrap).
  const fls = (repl.match(/<FullscreenLayout[\s/>]/g) ?? []).length
  const mcp = (repl.match(/<MCPConnectionManager[\s/>]/g) ?? []).length
  check('A: exactly ONE <FullscreenLayout> in REPL (no transcript twin)', fls === 1, `${fls}`)
  // The MCP servers are the SESSION's (its runner connects and manages them);
  // the face mounts no connection manager, so nothing of it can be lost on
  // the transcript toggle.
  check('A: NO <MCPConnectionManager> in REPL (the session runner manages MCP; nothing to survive the toggle)', mcp === 0, `${mcp}`)
  check('A: the unified mode flag drives the one skeleton', repl.includes('const inVirtualTranscript'))
  const legacy = repl.slice(repl.indexOf("if (screen === 'transcript' && !inVirtualTranscript)"))
  const legacyBlock = legacy.slice(0, legacy.indexOf('return transcriptReturn;'))
  check('A: the legacy dump branch has NO FullscreenLayout/MCP of its own', !legacyBlock.includes('<FullscreenLayout') && !legacyBlock.includes('<MCPConnectionManager'))
}

// ── B + C. live round-trip ───────────────────────────────────────────────────
const CTRL_O = String.fromCharCode(15)
const PAGE_UP = '\x1b[5~'

function run(
  tag: string,
  sends: Array<{ atTick: number; data: string }>,
  total: number,
  teeComposed = false,
): { grid: string[]; composed: string } {
  const dir = mkdtempSync(join(tmpdir(), `ctrlo-${tag}-`))
  const gridPath = join(dir, 'grid.json')
  const composed = join(dir, 'composed.jsonl')
  const cfgPath = join(dir, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID], sends, total, cols: 120, rows: 44, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(HERE, 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(90_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
      ...(teeComposed ? { INK_COMPOSED_TEE: composed } : {}),
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_TURN_RECEIPT: '0',
    },
  })
  check(`${tag}: PTY run completed`, res.status === 0, res.stderr?.slice(0, 160) ?? '')
  let grid: string[] = []
  try {
    const parsed = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c?: string }>> }
    grid = parsed.grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd())
  } catch {
    /* handled by the caller's assertions */
  }
  let composedText = ''
  try {
    composedText = readFileSync(composed, 'utf8')
  } catch {
    /* absent when not teeing / zero full-damage */
  }
  rmSync(dir, { recursive: true, force: true })
  return { grid, composed: composedText }
}

writeSyntheticSession('tall', SID)
// Reference: enter transcript, scroll up two pages, settle.
const refSends = [
  { atTick: 26, data: CTRL_O },
  { atTick: 32, data: PAGE_UP },
  { atTick: 34, data: PAGE_UP },
]
const ref = run('ref', refSends, 44)

writeSyntheticSession('tall', SID)
// Round-trip: same entry+scroll, then ctrl+o OUT and back IN.
const rtSends = [...refSends, { atTick: 40, data: CTRL_O }, { atTick: 46, data: CTRL_O }]
const rt = run('roundtrip', rtSends, 58, true)

// Compare the transcript CENTER PANE only (the rails carry live timers that
// legitimately differ between the two runs), skipping footer rows, and allow
// a ±3-row SHIFT: the two modes put different furniture (queue strip,
// workflow indicator, spacer) in the scrollable below the viewport, so the
// bottom-relative restore is exact only up to that furniture's height. The
// user-level claim asserted: the view returns to WHERE YOU WERE READING
// (within a couple of rows) — never resets to the bottom (the pre-fix
// remount behavior).
const CENTER_X = 26
const centerRows = (g: string[]) => g.slice(1, Math.max(0, g.length - 4)).map(r => r.slice(CENTER_X).trimEnd())
const refC = centerRows(ref.grid)
const rtC = centerRows(rt.grid)
const matchAtShift = (shift: number): number => {
  let hits = 0
  let total = 0
  for (let i = 0; i < refC.length; i++) {
    const a = refC[i] ?? ''
    const b = rtC[i + shift] ?? ''
    if (a === '' && b === '') continue
    total++
    if (a === b) hits++
  }
  return total === 0 ? 0 : hits / total
}
let bestShift = 0
let bestScore = -1
for (let sft = -3; sft <= 3; sft++) {
  const score = matchAtShift(sft)
  if (score > bestScore) {
    bestScore = score
    bestShift = sft
  }
}
if (process.env.CTRLO_DEBUG) console.log(`  · best shift ${bestShift} score ${(bestScore * 100).toFixed(1)}%`)
check(
  'B: reading position survives ctrl+o out→in (center rows match within ±3-row shift)',
  ref.grid.length > 0 && bestScore >= 0.9,
  `best shift ${bestShift}, ${(bestScore * 100).toFixed(1)}% rows matched`,
)
// Bottom-guard: the round-trip view must NOT be the bottom of the transcript
// (the pre-fix failure mode). The scrolled reference doesn't show the last
// turn's tail; neither may the round-trip.
const lastTurnMarker = 'turn 18'
check(
  'B: round-trip did NOT reset to the bottom',
  !rtC.join('\n').includes(lastTurnMarker),
  'bottom content visible after round-trip',
)

// C: full-damage frames across both toggles bounded (structural classes).
let fullDamage = 0
for (const line of rt.composed.trim().split('\n')) {
  if (!line) continue
  try {
    const p = JSON.parse(line) as { phase?: string; reason?: string }
    if (p.phase === 'full-damage' && p.reason && /removed-child|moved|scroll/.test(p.reason)) fullDamage++
  } catch {
    /* tree dumps etc. */
  }
}
check('C: ≤ 14 structural full-damage frames across the whole scrolled round-trip (2 flips + 2 PageUps + chrome swaps; a per-frame damage storm would be 3-5× this)', fullDamage <= 14, `${fullDamage}`)

cleanupScenario('ctrl-o-stable')
console.log(failures === 0 ? '\n✓ prove-ctrl-o-stable: all green' : `\n✗ prove-ctrl-o-stable: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
