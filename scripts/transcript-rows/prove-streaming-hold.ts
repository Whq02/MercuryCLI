#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-streaming-hold.ts — COCKPIT S7: the working
//  strip is NEVER an empty card, proven on the SHIPPED artifact.
//
//  The law: while a turn is live and the verb row yields to streaming prose,
//  the reserved slot carries the TRUTH-tier hold (the shared ◐ rotation +
//  the turn's elapsed time). Before S7 a hung/stalled stream rendered the
//  dressed WorkCapsule as an EMPTY bordered card beside the critter and the
//  app read as idle (the only text motion was the 1Hz header clock —
//  grammar-diag).
//
//  Method: one hermetic artifactArena HANG run (prose arrives, stream never
//  settles); assert the berth capsule region carries the work glyph + a
//  duration, at two instants 2s apart (the timer actually advances).
// ============================================================================

import { grabScreens, runArtifactArena } from '../streaming/artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── streaming-hold (shipped artifact) ──')

const run = await runArtifactArena({
  turns: [{ kind: 'hang', deltas: ['thinking hard.\n'] }],
  sends: ['4500:hello', '5300:\\r'],
  seconds: 13,
  probe: true,
  keep: true,
  extraEnv: { MERCURY_LIVE_GLYPHS: '1', MERCURY_CRITTER_GAZE: '0' },
})
const [t1, t2] = grabScreens(run, 120, 40, [S(8000), S(10100)])

// The berth capsule lives in the top berth band (the rows beside the
// critter, inside the ✶ SESSION card — rows 2..12 at 120x40).
const berth = (rows: string[]): string => rows.slice(2, 13).join('\n')
const HOLD = /[◐◓◑◒]\s+(\d+)s/
check('mid-stream the berth capsule carries the ◐ hold + elapsed', HOLD.test(berth(t1!.rows)))
check('the hold survives a stalled stream (still there 2s later)', HOLD.test(berth(t2!.rows)))
{
  const e1 = Number(berth(t1!.rows).match(HOLD)?.[1] ?? -1)
  const e2 = Number(berth(t2!.rows).match(HOLD)?.[1] ?? -1)
  check('the elapsed timer ADVANCES across the stall', e2 > e1, `${e1}s → ${e2}s`)
}
// The empty-card class is dead: no bordered berth row whose interior is all
// blank between its ╭/│ frame and the card edge, in the capsule column band.
{
  const emptyCard = t1!.rows
    .slice(2, 13)
    .some(r => /│\s{20,}│\s*│\s*│\s*$/.test(r))
  check('no empty bordered capsule row beside the critter', !emptyCard)
}
run.cleanup()

console.log(failures === 0 ? '✅ streaming-hold GREEN' : `❌ streaming-hold RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
