#!/usr/bin/env bun

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

const saved = process.env.MERCURY_CARRY_FORWARD
delete process.env.MERCURY_CARRY_FORWARD
t('unset ⇒ ENABLED (default-ON graduation)', carryForwardEnabled())
process.env.MERCURY_CARRY_FORWARD = '0'
t('flag =0 ⇒ disabled (opt-out preserved)', !carryForwardEnabled())
delete process.env.MERCURY_CARRY_FORWARD
{
  const savedMacro = (globalThis as Record<string, unknown>).MACRO
  delete (globalThis as Record<string, unknown>).MACRO
  t('no MACRO ⇒ STILL enabled (stamp-independence)', carryForwardEnabled())
  ;(globalThis as Record<string, unknown>).MACRO = savedMacro
}
if (saved === undefined) delete process.env.MERCURY_CARRY_FORWARD
else process.env.MERCURY_CARRY_FORWARD = saved

const note = buildCarryForwardNote(87.4, 'req-abc123')
t('kind is note', note.kind === 'note')
t('daemon-voiced', note.from === 'daemon')
t('carries ctx%', note.text.includes('87%'))
t('anchors last dispatch', note.refRequestId === 'req-abc123' && note.text.includes('req-abc123'))
t('instructs re-orient + report', /chatroom/.test(note.text) && /team-lead/.test(note.text))

const bare = buildCarryForwardNote(undefined, undefined)
t('unknown ctx reads "the ceiling"', bare.text.includes('the ceiling'))
t('no anchor when no dispatch', bare.refRequestId === undefined)

const seen = new Set<string>(['a1', 'b2', 'c3'])
t('last of insertion order', lastSeenDispatchId(seen) === 'c3')
t('empty set ⇒ undefined', lastSeenDispatchId(new Set()) === undefined)
t('undefined set ⇒ undefined', lastSeenDispatchId(undefined) === undefined)

console.log(fail ? '❌ CARRY-FORWARD RED' : '✅ CARRY-FORWARD GREEN')
process.exit(fail)
