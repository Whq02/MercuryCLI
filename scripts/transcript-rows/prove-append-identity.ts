#!/usr/bin/env bun
(globalThis as unknown as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { emptyFoldState, applyTranscriptEntry } = await import('../../src/sessions/transcripts/fold.ts')
const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('── transcript fold row-identity law ──')

{
  const row = (uuid: string, text: string) => ({ type: 'user', uuid, parentUuid: null, message: { role: 'user', content: text } })
  const state = emptyFoldState()
  const a1 = row('a', 'first')
  const b = row('b', 'second')
  applyTranscriptEntry(state, a1 as never)
  applyTranscriptEntry(state, b as never)
  const before = [...state.messages.values()]
  check('distinct uuids append in order', before[0] === a1 && before[1] === b, 'rows with distinct uuids must keep arrival order: fix applyTranscriptEntry in src/sessions/transcripts/fold.ts')
  const a2 = row('a', 'settled-late')
  applyTranscriptEntry(state, a2 as never)
  const replaced = [...state.messages.values()]
  check('a double-emit replaces in place without growth', replaced.length === 2 && replaced[0] === a2 && replaced[1] === b, `size ${replaced.length}; a repeated uuid must replace its row in place: fix applyTranscriptEntry in src/sessions/transcripts/fold.ts`)
  check('previous row objects are never mutated', a1.message.content === 'first' && before[0] === a1, 'the fold must store each row object as given and never edit one: fix applyTranscriptEntry in src/sessions/transcripts/fold.ts')
  const twin = row('c', 'second')
  applyTranscriptEntry(state, twin as never)
  check('identical content under a different uuid stays a second row', state.messages.size === 3 && [...state.messages.values()][2] === twin, `size ${state.messages.size}; rows are keyed by uuid, never by content: fix applyTranscriptEntry in src/sessions/transcripts/fold.ts`)
}


{
  const mk = (uuid: string) => ({
    type: 'assistant', uuid, parentUuid: null, timestamp: '2026-08-24T02:00:00.000Z',
    message: { id: 'm_1', role: 'assistant', type: 'message', model: 'gpt-5.6-sol', content: [{ type: 'text', text: 'the settled sentence', citations: null }], stop_reason: null, stop_sequence: null, usage: {}, container: null, context_management: null },
  })
  const state = emptyFoldState()
  applyTranscriptEntry(state, mk('u1') as never)
  applyTranscriptEntry(state, mk('u1') as never)
  const normalized = normalizeMessages([...state.messages.values()] as never)
  check('a replayed settle normalises to one row', normalized.length === 1 && normalized[0]!.uuid === 'u1', `${normalized.length} rows; a replayed settle must fold to one row: fix applyTranscriptEntry in src/sessions/transcripts/fold.ts or normalizeMessages in src/engine/message-shapes/normalize.ts`)
}

console.log(failures === 0 ? 'append-identity GREEN' : `append-identity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
