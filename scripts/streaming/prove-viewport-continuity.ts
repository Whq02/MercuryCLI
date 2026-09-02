#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-viewport-continuity.ts — viewport anchoring +
//  scroll continuity, proven on the SHIPPED artifact.
//
//  Two hermetic app-scale runs (artifactArena, 120×40 PTY, paced fixture
//  streaming ~66 numbered lines — taller than the session viewport), screens
//  reconstructed from the PTY byte log via pyte (screengrab.py):
//
//  Scene FOLLOW (no user scroll):
//    V1 follow-bottom — the tail is visible at stream end (the LAST line
//       painted on the final screen; the view followed all growth).
//    V2 the follow was the RENDERER's positional follow — 'scroll:follow'
//       probe marks fired during the stream (intent inspectable, S6).
//
//  Scene SCROLL-AWAY (wheel-up mid-stream):
//    V3 unstick intent recorded — 'scroll:unstick' marks land at wheel time.
//    V4 not dragged back — content that streams AFTER the wheel never drags
//       the view down: the final screen does NOT show the last line.
//    V5 anchored through the settle swap — the transcript band still shows
//       the scrolled-to region shortly after the turn settles (the swap's
//       transient content collapse must not move the view), the FINAL
//       screen still holds that region (a settle never yanks the reader
//       anywhere — not to the bottom, not to the new message's start), and
//       the way back is offered: the jump pill stands on the final screen.
//       WHY V5b changed (operator-ruled): its older text asked
//       for a DESIGNED post-settle anchor to the unseen message's start
//       (the '── N new ──' divider + the first lines) — the 'scroll:anchor'
//       emitter of an earlier settle fix, which a later rewrite dropped
//       and which the ratified behaviour spec (S24,
//       "Unseen-message tracking") never describes: the spec's settle holds
//       the view and the pill names the way back. A yank no spec describes
//       is not the product; the divider row itself paints only on the
//       non-virtual transcript (the default cockpit is the virtual list).
//    V6 no re-stick behind the user — zero 'scroll:stick'/'scroll:restick'
//       marks after the wheel (stickiness stays broken until the operator
//       jumps back).
// ============================================================================

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markEpochs, runArtifactArena, type ArenaRun } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ~66 numbered lines at 25 deltas/s ≈ 5.3s of streaming, far taller than
// the ~28-row transcript viewport. Distinct needles per line.
const LINES = 66
const deltas: string[] = []
for (let i = 1; i <= LINES; i++) {
  deltas.push(`vp-line-${String(i).padStart(2, '0')} `)
  deltas.push(`flux anchor probe\n`)
}
const LAST_NEEDLE = `vp-line-${LINES}`

function screens(run: ArenaRun, offsets: number[]): { atMs: number; rows: string[] }[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', ...offsets.map(String)],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (res.status !== 0) throw new Error(`screengrab failed: ${res.stderr}`)
  return (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
}

const flat = (rows: string[]): string => rows.join('\n')

console.log('── FLUX S6 viewport anchoring + scroll continuity (shipped artifact) ──')

// ── scene FOLLOW ────────────────────────────────────────────────────────────
{
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 40, whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 14,
    probe: true,
    keep: true,
  })
  const fin = screens(run, [-1])[0]!
  check('V1 follow-bottom: last line visible at stream end', flat(fin.rows).includes(LAST_NEEDLE))
  const follows = run.probe ? markEpochs(run.probe, 'scroll:follow').length : -1
  check('V2 positional follow fired during growth', follows > 5, `${follows} follow marks`)
  check('FOLLOW scene: fixture streamed fully', run.fixture.pacedEmits.length === deltas.length)
  run.cleanup()
}

// ── scene SCROLL-AWAY ───────────────────────────────────────────────────────
{
  // Stream starts ~5.5s; ~12.6 lines/s ⇒ viewport (~28 rows) overflows by
  // ~8s. Wheel-up ×4 at 9.6–10.2s (over the transcript, col 60 row 20),
  // stream ends ~10.8s, settle follows; capture to 14s.
  const WHEEL = '\\x1b[<64;60;20M'
  const run = await runArtifactArena({
    // settleDelayMs: hold the TERMINAL frames 1500ms
    // after the last delta — the fixture's own knob for isolating the settle
    // swap from the delta/wheel drain. On the calibration machine the drain
    // always quiesced inside the old streamEnd−200 margin; a loaded 2-core
    // runner was still painting queued deltas there, so the two samples
    // straddled residual drain and the vp window legitimately differed. The
    // LAW is unchanged: the exact visible window survives the swap.
    turns: [{ kind: 'paced', deltas, gapMs: 40, settleDelayMs: 1500, whenModel: 'opus' }],
    sends: [
      '4500:hello',
      '5300:\\r',
      `9600:${WHEEL}`,
      `9800:${WHEEL}`,
      `10000:${WHEEL}`,
      `10200:${WHEEL}`,
    ],
    seconds: 16,
    probe: true,
    keep: true,
  })
  const boot = run.teeLines[0]?.ts ?? 0
  const wheelAtDrive = run.sendLog.filter(s =>
    Buffer.from(s.b64, 'base64').toString('utf8').includes('[<64'),
  )
  const lastWheelTs = Math.max(...wheelAtDrive.map(s => s.sent))
  const streamEnd = (run.fixture.pacedEmits.at(-1)?.at ?? 0) - boot
  // Bracket the SETTLE SWAP itself. The fixture holds terminal frames
  // settleDelayMs past the last delta, so the swap lands at
  // streamEnd + 1500 — sample just inside each side of THAT boundary; the
  // 1500ms hold is the drain window slow machines need (the old
  // streamEnd−200 margin assumed the calibration machine's paint speed).
  const SETTLE_AT = streamEnd + 1500
  const [beforeSettle, afterSettle, fin] = screens(run, [
    SETTLE_AT - 200,
    SETTLE_AT + 250,
    -1,
  ])
  check('SCROLL scene: wheels delivered', wheelAtDrive.length === 4, `${wheelAtDrive.length}`)

  const unsticks = run.probe
    ? markEpochs(run.probe, 'scroll:unstick').filter(t => t >= lastWheelTs - 1500).length
    : -1
  check('V3 unstick intent recorded at wheel time', unsticks > 0, `${unsticks} marks`)
  check('V4 not dragged back: last line NOT visible at end', !flat(fin!.rows).includes(LAST_NEEDLE))
  // The scrolled-to region must survive the settle swap (its transient
  // content collapse must not clamp scrollTop to 0 and yank the view
  // to the bottom). Compare the set of visible vp-lines shortly after the
  // wheel vs shortly after settle.
  const visLines = (rows: string[]): string =>
    rows
      .map(r => (r.match(/vp-line-(\d+)/) ?? [])[1])
      .filter(Boolean)
      .join(',')
  check(
    'V5a scrolled-to region survives the settle swap',
    visLines(beforeSettle!.rows).length > 0 &&
      visLines(beforeSettle!.rows) === visLines(afterSettle!.rows),
    `settle−200ms=[${visLines(beforeSettle!.rows)}] settle+250ms=[${visLines(afterSettle!.rows)}]`,
  )
  // The ratified law (S24): the settle never moves the reader — the final
  // screen still holds the region the operator scrolled to, three seconds
  // and more after the settle swap — and the way back is offered on it: the
  // jump pill ("[ N new messages · alt+↓ ]", or "[ back to the bottom ·
  // alt+↓ ]" on the virtual transcript, which counts no rows of its own).
  const finFlat = flat(fin!.rows)
  check(
    'V5b the final view still holds the scrolled-to region (the settle never yanks the reader)',
    visLines(fin!.rows).length > 0 && visLines(fin!.rows) === visLines(afterSettle!.rows),
    `settle+250ms=[${visLines(afterSettle!.rows)}] final=[${visLines(fin!.rows)}]`,
  )
  check(
    'V5c the way back is offered on the final screen (the jump pill stands)',
    /\[ (\d+ new messages?|back to the bottom) · alt\+↓ \]/.test(finFlat),
    `pill-shaped rows: ${fin!.rows.filter(r => /new message|back to the bottom|alt\+/.test(r)).map(r => r.trim()).join(' | ') || 'none'}`,
  )
  const restick = run.probe
    ? markEpochs(run.probe, 'scroll:stick').filter(t => t > lastWheelTs).length +
      markEpochs(run.probe, 'scroll:restick').filter(t => t > lastWheelTs).length
    : -1
  check('V6 no re-stick behind the user', restick === 0, `${restick} stick marks after wheel`)
  run.cleanup()
}

console.log(failures === 0 ? '✅ FLUX viewport-continuity GREEN' : `❌ FLUX viewport-continuity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
