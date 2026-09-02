#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-lifecycle-cards.ts — the tool-card lifecycle
//  grammar at app scale (queued/starting honesty + the denial vocabulary).
//
//  Note on the settle tick (recorded intentional change #3): it ALREADY
//  ships — useSettleFlash + the ember-settle bloom in ToolUseLoader
//  (alive-glyph pass; unit + opportunistic render coverage in
//  scripts/ui/prove-live-glyphs.ts / render-live-motion.ts). The S0 recon
//  line "no settle treatment" was stale; this proof covers the UNCOVERED
//  lifecycle laws:
//
//    C1 queued-on-permission honesty — while the permission card is up, the
//       tool row must NOT read as landed work: no ● success dot, no ✶
//       spark, no ◌ read-ring for the pending Bash row.
//    C2 the ask is visible — the permission card paints (the command text
//       reaches the screen).
//    C3 denial vocabulary — Esc on the card lands the ✕ DENIAL lead
// not the ▲ warn,
//       not a success dot.
//    C4 the session settles usable — composer hints return after the deny.
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

console.log('── FLUX S7b tool-card lifecycle grammar (shipped artifact) ──')

const run = await runArtifactArena({
  // Pinned to the MAIN model so the small-model side call the submit fires
  // (the session title) cannot eat the scripted turn.
  turns: [
    { kind: 'tool_use', name: 'Bash', input: { command: 'touch lifecycle-probe.txt' }, whenModel: 'opus' }, // mutating — MUST ask (echo is auto-approved by the safety analyzer)
    { kind: 'text', text: 'ok.', whenModel: 'opus' },
  ],
  // submit → the permission card appears while the tool is QUEUED on the
  // ask → Esc denies it at 9s → the turn settles with the rejection.
  // The deny fires only once the ask card is PAINTED (observed-ready): the
  // blind 9000ms ESC raced the card open on a slow runner and landed in the
  // composer instead.
  sends: ['4500:hello', '5300:\\r', 'after:lifecycle-probe:1200:\\x1b'],
  seconds: 16,
  keep: true,
})

function screenAt(offsets: number[]): { atMs: number; rows: string[] }[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', ...offsets.map(String)],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
}

// The tee opens with phase-diagnostic records that carry no ts — the boot
// instant is the first FRAME line's clock, not the first line's.
const boot = run.teeLines.find(l => typeof l.ts === 'number')?.ts ?? 0
const escTs = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\x1b')?.sent ?? 0
// The ask frame: the Esc fires 1200 ms after the command text first reached
// the byte stream, and the card is read off the screen shortly BEFORE the
// Esc. One fixed instant (Esc − 400 ms) sat inside a full repaint on a
// loaded box (the card's mount redraws the alt screen), so C2 read a
// half-painted grid and reported the command text gone. Three samples
// walk up to the Esc; the first that shows the command is the ask frame,
// the earliest stands as the evidence when none does.
const askOffsets = [escTs - boot - 400, escTs - boot - 200, escTs - boot - 60]
const [ask400, ask200, ask60, fin] = screenAt([...askOffsets, -1])
const duringAsk = [ask400, ask200, ask60].find(s => s !== undefined && /lifecycle-probe/.test(s.rows.join('\n'))) ?? ask400
// A missing screen is a journey that did not happen (no ESC was ever sent, or
// the drive has no final frame) — a loud failure, never a TypeError.
check('the ask frame and the final frame were both captured', duringAsk !== undefined && fin !== undefined, `escTs=${escTs} boot=${boot}`)
if (duringAsk === undefined || fin === undefined) {
  console.log(`❌ FLUX lifecycle-cards RED (${failures})`)
  process.exit(1)
}
const askFlat = duringAsk.rows.join('\n')
const finFlat = fin.rows.join('\n')

// C2 — the ask painted
check('C2 permission card visible before Esc', /lifecycle-probe/.test(askFlat), askFlat.length < 200 ? 'screen empty' : 'command text not on screen')
// A red carries its evidence: the rows on screen 400 ms before the Esc (the
// card, the pending row, whatever painted instead) — bounded to the rows
// that carry the drive's needles, so a host-only failure reads from the log.
if (!/lifecycle-probe/.test(askFlat)) {
  const keyed = duringAsk.rows.filter(r => /lifecycle|proceed|Yes|No,|Bash|touch|❯|Allow|permission|ask/i.test(r)).slice(0, 12)
  console.log(`  ── the ask frame (${duringAsk.atMs} ms): ${keyed.length} needle row(s)`)
  for (const r of keyed) console.log(`  │ ${r.trimEnd().slice(0, 118)}`)
}

// C1 — the pending row never reads as landed work
const rowLine = duringAsk!.rows.find(r => r.includes('lifecycle-probe') && !r.includes('❯')) ?? ''
check('C1a no success dot while queued on the ask', !/●/.test(rowLine), JSON.stringify(rowLine.slice(0, 60)))
check('C1b no spark/read-settle on the pending row', !rowLine.includes('✶') && !rowLine.includes('◌'), JSON.stringify(rowLine.slice(0, 60)))

// C3 — denial vocabulary on the settled screen
check('C3 denial lands the ✕ lead', finFlat.includes('✕'))

// C4 — usable settle
check('C4 composer idle hints returned', /[Tt]ype a prompt|↵ sends/.test(finFlat))

run.cleanup()

console.log(failures === 0 ? '✅ FLUX lifecycle-cards GREEN' : `❌ FLUX lifecycle-cards RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
