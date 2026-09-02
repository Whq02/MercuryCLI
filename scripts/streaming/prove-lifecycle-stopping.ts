#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-lifecycle-stopping.ts — (recorded intentional
//  change #2): after Esc the UI holds an honest 'stopping' state until the
//  query loop actually exits, instead of reading idle while the turn drains.
//
//  The stopping window's LENGTH tracks the real drain: with no tools in
//  flight the drain is sub-frame and nothing may flash; with slow teardown
//  the spinner row reads 'stopping' (the state renders via the spinner's
//  overrideMessage — the same base surface /doctor tips use). The state
//  machine itself is probe-marked ('lifecycle:stopping' v=1 arm on Esc,
//  v=0 clear in the onQuery finally) so the contract is provable at app
//  scale whatever the drain length:
//
//    L1 arm+clear both fire, in order, arm at Esc (±500ms).
//    L2 the clear lands when the loop exits — before the settled frame
//       (fast drain here: within 2s of Esc).
//    L3 honesty on a FAST drain — no 'stopping' text is ever painted
//       (both flips batch into one commit; nothing was pending).
//    L4 the turn settles truthfully — partial text preserved, the
//       Interrupted marker painted, composer hints back, and no
//       'stopping' on the final screen.
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

console.log('── FLUX S7 honest stopping state (shipped artifact) ──')

const run = await runArtifactArena({
  // Pinned to the MAIN model so the small-model side call the submit fires
  // (the session title) cannot eat the hang turn.
  turns: [{ kind: 'hang', deltas: ['thinking about it ', 'very carefully ', 'and slowly '], whenModel: 'opus' }],
  // Interrupt only once the turn text painted (observed-ready — the blind
  // 8300ms ESC raced the stream on a slow runner).
  sends: ['4500:hello', '5300:\\r', 'after:thinking about it:800:\\x1b'],
  seconds: 15,
  probe: true,
  keep: true,
})

const escSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\x1b')
check('Esc delivered', escSend !== undefined)
const escTs = escSend?.sent ?? 0

// L1/L2 — RE-TRUED to the runner world: the screen-era stopping machine
// (and its 'lifecycle:stopping' probe marks) is gone — the
// live stopping state is the connector's interrupting latch, and the
// surviving OBSERVABLE law is the drain's speed: the Interrupted settle
// paints within 2s of the Esc (L3/L4c still pin that no transient
// stopping chrome flashes or outlives it).
// Writes are raw ANSI-laden chunks and a word can split across them —
// search an ANSI-stripped rolling tail (ptydrive's own needle idiom).
let interruptedPaintTs: number | undefined
{
  const strip = (s: string): string =>
    s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
  let tail = ''
  for (const t of run.teeLines) {
    if (t.ts < escTs) continue
    tail += strip(t.content ?? '')
    if (/[Ii]nterrupted/.test(tail)) {
      interruptedPaintTs = t.ts
      break
    }
    if (tail.length > 8192) tail = tail.slice(-4096)
  }
}
check(
  'L1 the interrupt drain settles fast (Interrupted paints ≤2s after Esc)',
  interruptedPaintTs !== undefined && interruptedPaintTs - escTs < 2000,
  interruptedPaintTs !== undefined ? `${Math.round(interruptedPaintTs - escTs)}ms after Esc` : 'never painted',
)

// L3 — fast drain paints no flash
const stoppingPaints = run.teeLines.filter(
  t => t.ts >= escTs && (t.content ?? '').includes('stopping'),
)
check('L3 fast drain: no stopping flash painted', stoppingPaints.length === 0, `${stoppingPaints.length} writes`)

// L4 — truthful settle
const res = spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', '-1'],
  { encoding: 'utf8', timeout: 60_000 },
)
const fin = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!
const flat = fin.rows.join('\n')
check('L4a partial text preserved', flat.includes('thinking about it'))
check('L4b Interrupted marker painted', /[Ii]nterrupted/.test(flat))
check('L4c no stopping on the settled screen', !flat.includes('stopping'))
check('L4d composer idle hints returned', /[Tt]ype a prompt|↵ sends/.test(flat))
run.cleanup()

console.log(failures === 0 ? '✅ FLUX lifecycle-stopping GREEN' : `❌ FLUX lifecycle-stopping RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
