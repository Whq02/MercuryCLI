#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-polish-sweep.ts — continuity polish laws over
//  a standard turn (stream + tool + settle + post-settle typing).
//
//    P1 no stale running labels — after settle, the ◐◓◑◒ running family is
//       gone (the resolved read wears ◌; nothing still breathes).
//    P2 the cursor survives settle — at the final screen the terminal
//       cursor is VISIBLE (DECTCEM) and sits in the composer band; typed
//       post-settle glyphs echo beside it (cursor-disappearance law).
//    P3 the settle is complete — the settled text + the resolved tool row
//       are on screen and the composer is usable.
//
//  Sweep verdicts for the other two S10 classes are recorded in
//  the recorded sweep (settle-colour: streamed and settled
//  prose share the IVORY base by construction — S5's row-equality law is
//  the freeze; composer border lag: no measured violation — S3/S4 echo
//  p95 16–22ms, the border rides the same commit).
// ============================================================================

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runArtifactArena } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── FLUX S10 polish sweep (shipped artifact) ──')

const run = await runArtifactArena({
  seedCwd: { 'polish-probe.txt': 'one line of probe content\n' },
  // Pinned to the MAIN model so the small-model side call the submit fires
  // (the session title) cannot eat the scripted turns.
  turns: cwd => [
    { kind: 'tool_use', name: 'Read', input: { file_path: `${cwd}/polish-probe.txt` }, preText: 'reading the probe file now. ', whenModel: 'opus' },
    { kind: 'text', text: 'settled prose after the tool.', whenModel: 'opus' },
  ],
  sends: ['4500:hello', '5300:\\r', '10500:Λ', '11000:Θ'],
  seconds: 13,
  keep: true,
  // The POLISH sweep judges the visible chrome — it runs with the live
  // glyphs ON (overriding the arena's capture default): the settle caret
  // is the drawn ReadyBreath cell, invisible under the glyphs-off pin.
  extraEnv: { MERCURY_LIVE_GLYPHS: '1' },
})

const res = spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', '-1'],
  { encoding: 'utf8', timeout: 60_000 },
)
const fin = (
  JSON.parse(res.stdout) as {
    screens: {
      rows: string[]
      cursor?: { x: number; y: number; hidden: boolean }
      reverseCells?: [number, number][]
    }[]
  }
).screens[0]!
const flat = fin.rows.join('\n')

// P3 — complete settle
check('P3a settled prose painted', flat.includes('settled prose after the tool.'))
check('P3b resolved read wears ◌', flat.includes('◌'))
// with TEXT in the composer the idle hints hide — typed echo IS usability
check('P3c composer usable', /type a prompt|↵ sends|\? for shortcuts/.test(flat) || flat.includes('ΛΘ'))

// P1 — no stale running labels after settle. The focused-session status
// row (the '⇧← back' strip) lawfully wears the RESTING work glyph — the
// static GLYPH.inProgress WorkingGlyph renders when active=false — so the
// sweep excludes that one row: a stale SPINNER anywhere else still reds.
const sweepRows = fin.rows.filter(r => !r.includes('← back') && !r.includes('esc interrupts'))
check('P1 no ◐◓◑◒ running family after settle (outside the status row\'s resting glyph)', !/[◐◓◑◒]/.test(sweepRows.join('\n')))

// P2 — a visible caret at settle: Mercury draws its own caret (an
// inverse-video cell) and hides the hardware cursor — EITHER form counts;
// NEITHER visible is the cursor-disappearance defect.
const caretDrawn = (fin.reverseCells ?? []).some(([, y]) => fin.cursor !== undefined && Math.abs(y - fin.cursor.y) <= 1)
check(
  'P2a a caret is visible at settle (hardware cursor OR drawn inverse cell)',
  (fin.cursor !== undefined && !fin.cursor.hidden) || caretDrawn,
  `cursor=${JSON.stringify(fin.cursor)} reverseNearCursor=${caretDrawn}`,
)
const composerRowIdx = fin.rows.findIndex(r => r.includes('ΛΘ'))
check('P2b post-settle glyphs echoed', composerRowIdx >= 0)
check(
  'P2c cursor sits on the composer row',
  fin.cursor !== undefined && composerRowIdx >= 0 && Math.abs(fin.cursor.y - composerRowIdx) <= 1,
  `cursor.y=${fin.cursor?.y} composerRow=${composerRowIdx}`,
)
run.cleanup()

console.log(failures === 0 ? '✅ FLUX polish-sweep GREEN' : `❌ FLUX polish-sweep RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
