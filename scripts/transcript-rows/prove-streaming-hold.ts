#!/usr/bin/env bun

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

const berth = (rows: string[]): string => rows.slice(2, 13).join('\n')
const HOLD = /[◐◓◑◒]\s+(\d+)s/
check('mid-stream the berth capsule carries the ◐ hold + elapsed', HOLD.test(berth(t1!.rows)), `the live capsule beside the critter must show a ◐ glyph and the elapsed seconds while a stream is open; berth rows 2 to 12 at 8s were:\n${berth(t1!.rows)}`)
check('the hold survives a stalled stream (still there 2s later)', HOLD.test(berth(t2!.rows)), `the ◐ hold and elapsed seconds must stay on the capsule while the stream stalls; berth rows 2 to 12 at 10.1s were:\n${berth(t2!.rows)}`)
{
  const e1 = Number(berth(t1!.rows).match(HOLD)?.[1] ?? -1)
  const e2 = Number(berth(t2!.rows).match(HOLD)?.[1] ?? -1)
  check('the elapsed timer ADVANCES across the stall', e2 > e1, `the elapsed seconds on the hold capsule must keep counting during a stalled stream; ${e1}s → ${e2}s (-1 means no hold was found)`)
}
{
  const emptyCard = t1!.rows
    .slice(2, 13)
    .some(r => /│\s{20,}│\s*│\s*│\s*$/.test(r))
  check('no empty bordered capsule row beside the critter', !emptyCard, `a capsule row with a border and no content was drawn beside the critter; berth rows 2 to 12 at 8s were:\n${berth(t1!.rows)}`)
}
run.cleanup()

console.log(failures === 0 ? '✅ streaming-hold GREEN' : `❌ streaming-hold RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
