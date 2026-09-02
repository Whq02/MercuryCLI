#!/usr/bin/env bun
// prove-carry-forward.ts — locks the P7 respawn task-state handoff
// (utils/scribe/carryForward.ts): the gate (default-ON since,
// ladder tier `additive`; =0 opts the scribe stream out — the party lane is
// unconditional in roster.ts either way), the note's protocol shape
// (daemon-voiced, never implementer), and the last-dispatch anchor.

// stamp-sim BEFORE import (the build stamp reads MACRO.VERSION) — without it
// the gate checks pass vacuously on the bare-stamp false arm.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  buildCarryForwardNote,
  carryForwardEnabled,
  lastSeenDispatchId,
} from '../../src/utils/scribe/carryForward.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// 1) Gate: default-ON; =0 opts out; stamp-independent.
const saved = process.env.MERCURY_CARRY_FORWARD
delete process.env.MERCURY_CARRY_FORWARD
t('unset ⇒ ENABLED (default-ON graduation)', carryForwardEnabled())
process.env.MERCURY_CARRY_FORWARD = '0'
t('flag =0 ⇒ disabled (opt-out preserved)', !carryForwardEnabled())
delete process.env.MERCURY_CARRY_FORWARD
{
  // the default is stamp-independent.
  const savedMacro = (globalThis as Record<string, unknown>).MACRO
  delete (globalThis as Record<string, unknown>).MACRO
  t('no MACRO ⇒ STILL enabled (stamp-independence)', carryForwardEnabled())
  ;(globalThis as Record<string, unknown>).MACRO = savedMacro
}
if (saved === undefined) delete process.env.MERCURY_CARRY_FORWARD
else process.env.MERCURY_CARRY_FORWARD = saved

// 2) Note shape: kind 'note', daemon-voiced (protocol forbids implementer),
//    carries the ctx% and the re-orient instruction.
const note = buildCarryForwardNote(87.4, 'req-abc123')
t('kind is note', note.kind === 'note')
t('daemon-voiced', note.from === 'daemon')
t('carries ctx%', note.text.includes('87%'))
t('anchors last dispatch', note.refRequestId === 'req-abc123' && note.text.includes('req-abc123'))
t('instructs re-orient + report', /chatroom/.test(note.text) && /team-lead/.test(note.text))

// 3) Unknown ctx / no dispatch: honest fallbacks, no fabricated anchor.
const bare = buildCarryForwardNote(undefined, undefined)
t('unknown ctx reads "the ceiling"', bare.text.includes('the ceiling'))
t('no anchor when no dispatch', bare.refRequestId === undefined)

// 4) lastSeenDispatchId: insertion-ordered Set → most recent id; empty → undefined.
const seen = new Set<string>(['a1', 'b2', 'c3'])
t('last of insertion order', lastSeenDispatchId(seen) === 'c3')
t('empty set ⇒ undefined', lastSeenDispatchId(new Set()) === undefined)
t('undefined set ⇒ undefined', lastSeenDispatchId(undefined) === undefined)

console.log(fail ? '❌ CARRY-FORWARD RED' : '✅ CARRY-FORWARD GREEN')
process.exit(fail)
