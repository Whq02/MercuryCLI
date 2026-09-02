#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-crew-chat.ts
//  PROOF: the mini-chat feed's derive (#71) — utils/cockpit/crewChatRows is
//  React-free so the whole feed's logic is provable without a PTY:
//    · kind → glyph/tone follows the STATUS vocabulary (○ ◐ ● ⚠ ·), with the
//      progress status sniffed from the preview head;
//    · party echoes (ring, newest LAST) come out newest-FIRST and bounded;
//    · mailbox tails parse scribe_protocol envelopes, keep plain text as a
//      note, SKIP non-envelope protocol JSON (permission/shutdown machinery),
//      and merge-sort across inboxes;
//    · routes compact to the rail budget (team-lead→lead, implementer→impl).
//  The pixel probe that drove this feed over the retired seat estate's
//  fixture left with that estate; the derive is the law here, and the scribe
//  source's rows ride the same component the cockpit captures cover.
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-crew-chat.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import {
  CREW_CHAT_ROWS,
  crewChatKindView,
  crewChatRowsFromMailbox,
  parseEnvelopePreview,
  shortCrewName,
} from '../../src/utils/cockpit/crewChatRows.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' crew-chat derive — the rail mini-feed logic (render-free)')
console.log('============================================================')

section('kind → glyph/tone (the status vocabulary)')
check('dispatch ○ info', JSON.stringify(crewChatKindView('dispatch', 'x')) === '{"glyph":"○","tone":"info"}')
check('progress working ◐ work', JSON.stringify(crewChatKindView('progress', 'working on it')) === '{"glyph":"◐","tone":"work"}')
check('progress done ● ok', JSON.stringify(crewChatKindView('progress', 'done · verify green')) === '{"glyph":"●","tone":"ok"}')
check('progress failed ● block', JSON.stringify(crewChatKindView('progress', 'failed suite red')) === '{"glyph":"●","tone":"block"}')
// The warn glyph carries VS15 (U+FE0E — text presentation; item 10's census):
// U+26A0 is emoji-eligible and Windows Terminal paints the bare codepoint as
// a colour emoji. The pin is the COMPOSED needle.
check('progress blocked ⚠ warn', JSON.stringify(crewChatKindView('progress', 'blocked: need a call')) === '{"glyph":"⚠\uFE0E","tone":"warn"}')
check('escalate ⚠ warn', crewChatKindView('escalate', 'anything').glyph === '⚠\uFE0E')
check('control · info', crewChatKindView('control', 'stop').glyph === '·')
check('unknown kind degrades to · info', crewChatKindView('mystery', '').glyph === '·')

section('route compaction')
check('team-lead → lead', shortCrewName('team-lead') === 'lead')
check('implementer → impl', shortCrewName('implementer') === 'impl')
check('healer → heal', shortCrewName('healer') === 'heal')
check('tank passes through', shortCrewName('tank') === 'tank')
check('long unknown truncates to 4', shortCrewName('longbeard') === 'long')

section('mailbox tails → rows (envelope parse + machinery skip + merge)')
const env = (kind: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ type: 'scribe_protocol', kind, request_id: 'r', from: 'x', timestamp: 't', ...extra })
const inboxes = [
  {
    inbox: 'team-lead',
    messages: [
      { from: 'implementer', text: env('progress', { status: 'done', detail: 'shipped' }), timestamp: '2026-07-04T10:00:03.000Z' },
      { from: 'implementer', text: JSON.stringify({ type: 'permission_request', id: 'p1' }), timestamp: '2026-07-04T10:00:04.000Z' },
      { from: 'implementer', text: 'plain human reply', timestamp: '2026-07-04T10:00:05.000Z' },
      { from: 'implementer', text: 'bad ts', timestamp: 'not-a-date' },
    ],
  },
  {
    inbox: 'implementer',
    messages: [
      { from: 'team-lead', text: env('dispatch', { task: 'Objective: fix the flag\nDetails…', title: undefined }), timestamp: '2026-07-04T10:00:01.000Z' },
    ],
  },
]
const mailRows = crewChatRowsFromMailbox(inboxes)
check('machinery JSON skipped, bad ts skipped', mailRows.length === 3)
check('merged newest first', mailRows[0]?.gist === 'plain human reply')
check('envelope progress parsed + toned', mailRows[1]?.gist === 'done shipped' && mailRows[1]?.tone === 'ok')
check('dispatch task first-lined', mailRows[2]?.gist === 'Objective: fix the flag')
check('routes read to↔from', mailRows[2]?.route === 'lead→impl' && mailRows[0]?.route === 'impl→lead')

section('parseEnvelopePreview edges')
check('non-JSON → null', parseEnvelopePreview('hello') === null)
check('non-protocol JSON → null', parseEnvelopePreview('{"type":"other","kind":"dispatch"}') === null)
check('malformed JSON → null', parseEnvelopePreview('{nope') === null)
check('control formats command+detail', parseEnvelopePreview(env('control', { command: 'stop', detail: 'now' }))?.preview === 'stop now')
check('escalate uses reason', parseEnvelopePreview(env('escalate', { reason: 'stuck' }))?.preview === 'stuck')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CREW-CHAT PROOFS PASS')
else console.log(`❌ ${failures} CREW-CHAT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
