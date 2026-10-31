import assert from 'node:assert/strict'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import { chatRows } from '../../src/services/crewBoard/chat.ts'
import type { BoardPost } from '../../src/services/crewBoard/contracts.ts'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
let now = 0
const path = join(home, 'corrections.sqlite')
const board = open(path, 'corrections', () => now)
const a = { author: { sessionId: 'corrections', agentId: 'alpha', executionId: 'run' }, name: 'Alpha' }
const b = { author: { sessionId: 'corrections', agentId: 'beta', executionId: 'run' }, name: 'Beta' }
board.enroll(a); board.enroll(b)
let serial = 0
const post = (seat: typeof a, input: Omit<BoardPost, 'clientOpId'>) => {
  now += 15000
  const result = board.post(seat, { ...input, clientOpId: `correction-${++serial}` })
  assert(result.ok, JSON.stringify(result))
  return result
}
const first = post(a, { kind: 'ask', text: 'How many rows?', threadId: 'rows' })
const wrong = post(b, { kind: 'answer', text: 'Four rows.', replyTo: first.eventId })
const original = board.view().events.find(event => event.eventId === wrong.eventId)!
for (let i = 0; i < 5; i++) post(b, { kind: 'answer', text: `Checking my count ${i}.`, replyTo: wrong.eventId })
const second = post(a, { kind: 'ask', text: 'Does that include the footer?', threadId: 'rows' })
post(b, { kind: 'answer', text: 'No.', replyTo: second.eventId })
const capped = board.post(a, { clientOpId: 'too-many-rounds', kind: 'ask', threadId: 'rows', text: 'A third round.' })
assert(!capped.ok && capped.cap === 'thread-rounds')
const correction = post(b, { kind: 'correction', corrects: wrong.eventId, text: 'There are five rows including the footer.' })
assert.equal(board.view().events.find(event => event.eventId === wrong.eventId)!.text, original.text)
const corrected = board.view().events.find(event => event.eventId === correction.eventId)!
assert.equal(corrected.threadId, original.threadId)
assert.equal(corrected.corrects, original.eventId)
post(b, { kind: 'answer', replyTo: wrong.eventId, text: 'My correction stands.' })
assert(!board.post(b, { clientOpId: 'absent', kind: 'correction', corrects: 'missing', text: 'No target.' }).ok)
const rows = chatRows(board.view())
assert(rows.findIndex(row => row.id === wrong.eventId) < rows.findIndex(row => row.id === second.eventId), 'each answer stays below its own ask, before the next ask')
assert(rows.find(row => row.id === wrong.eventId)!.kind.includes('→ correction'))
assert(rows.find(row => row.id === correction.eventId)!.reply)
assert.equal(rows.find(row => row.id === correction.eventId)!.thread, rows.find(row => row.id === wrong.eventId)!.thread)
board.close()
const reopened = open(path, 'corrections', Date.now, true)
assert.deepEqual(reopened.view().events.find(event => event.eventId === wrong.eventId), original)
assert.equal(reopened.view().events.find(event => event.eventId === correction.eventId)!.corrects, original.eventId)
reopened.close()
console.log('PASS corrections and self-answers never consume rounds; the cap names itself; corrections append and link without replacing history')
