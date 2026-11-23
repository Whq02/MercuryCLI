import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { open } from '../../src/crew/board/store.ts'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
let now = 0
const board = open(join(home, 'addressing.sqlite'), 'addressing', () => now)
const principal = (id: string, name = id, team?: string) => ({ author: { sessionId: 'addressing', agentId: id, executionId: 'run' }, name, team })
const lead = principal('main')
const alpha = principal('a', 'Alpha', 'engine')
const beta = principal('b', 'Beta', 'engine')
const gamma = principal('c', 'Gamma', 'view')
const delta = principal('d', 'Delta', 'other')
for (const seat of [lead, alpha, beta, gamma, delta]) board.enroll(seat)
let serial = 0
const post = (text: string, extra = {}) => {
  now += 15000
  const receipt = board.post(alpha, { clientOpId: `p${++serial}`, kind: 'result', text, ...extra })
  assert(receipt.ok, JSON.stringify(receipt))
  return receipt
}
const unknown = post('A result without a task.', { mentions: ['not-here'], about: 'src/parser.ts' })
assert.deepEqual(unknown.unknownMentions, ['not-here'])
assert.equal(board.view().events[0]!.about, 'src/parser.ts')
assert.equal(board.view().events[0]!.taskId, undefined)
assert.deepEqual(board.view().events[0]!.mentions, [])
assert(board.boundary(gamma, new Set())?.eventIds.includes(unknown.eventId), 'post with unknown mention did not reach other seat boundary in src/crew/board/store.ts')
console.log('PASS 1–2 unknown mentions land as plain posts that reach every seat; results and blockers need no task or evidence')
post('An independent blocker.', { kind: 'blocker' })
const direct = post('@Gamma please read this.', { about: 'src/parser.ts', threadId: 'parser-finding' })
const delivered = board.boundary(gamma, new Set())!
assert(delivered.eventIds.includes(direct.eventId), 'direct @Gamma post missing from Gamma boundary eventIds in src/crew/board/store.ts')
assert(delivered.text.includes('[Alpha] [engine] [result]: @Gamma please read this.'), `direct @Gamma packet body mismatch in src/crew/board/store.ts: ${delivered.text.slice(0, 200)}`)
assert(delivered.text.includes('"about":"src/parser.ts"') && delivered.text.includes('"thread":"parser-finding"'), `direct @Gamma packet omitted about/thread metadata in src/crew/board/store.ts: ${delivered.text.slice(0, 200)}`)
assert(board.boundary(delta, new Set())?.eventIds.includes(direct.eventId), 'a post addressed to one seat still reaches every seat')
const team = post('A view question.', { to: ['view'] })
assert(board.boundary(gamma, new Set([direct.eventId]))?.eventIds.includes(team.eventId), 'to:[view] post missing from Gamma boundary in src/crew/board/store.ts')
const all = post('@all read the common finding.')
for (const seat of [lead, beta, gamma, delta]) assert(board.boundary(seat, new Set())?.eventIds.includes(all.eventId), `@all post missing from ${seat.name} boundary in src/crew/board/store.ts`)
const priority = board.boundary(beta, new Set())!
assert.equal(priority.eventIds[0], all.eventId, 'mentions precede older unaddressed delivery')
assert(board.boundary(beta, new Set([all.eventId]))?.eventIds.includes(unknown.eventId), 'every seat receives unmentioned posts')
const plain = post('An unaddressed finding reaches every seat without a mention.')
for (const seat of [lead, beta, gamma, delta]) assert(board.boundary(seat, new Set())?.eventIds.includes(plain.eventId), `unaddressed post missing from ${seat.name} boundary in src/crew/board/store.ts`)
const relevance = post('A file finding.', { files: ['parser.ts'] })
assert(board.boundary(delta, new Set([all.eventId]))?.eventIds.includes(relevance.eventId), 'file-tagged post missing from Delta boundary in src/crew/board/store.ts')
assert.equal(board.assignTeam(beta, 'Gamma', 'engine').ok, false)
assert.equal(board.assignTeam(lead, 'Gamma', 'engine').ok, true)
assert.equal(board.assignTeam(lead, 'Gamma', 'all').ok, false)
assert.equal(board.read(delta, { team: 'view' }).events.length, 0)
assert(board.read(delta, {}).events.some(event => event.eventId === unknown.eventId), 'general is visible across teams')
assert(board.view(undefined, undefined, 'engine').events.every(event => event.team === 'engine'), 'board.view team=engine filter leaked non-engine event in src/crew/board/store.ts')
assert.equal(board.view(undefined, undefined, 'view').events.length, 0)
console.log('PASS 4–6 text and to address seats, teams and all; every post reaches every seat, mentions first; public team channels')
const reader = principal('reader')
board.enroll(reader)
assert.equal(board.view().omitted, 0)
const full = board.view().events
const packed = board.read(reader, { since: 0 })
assert(full.length > 1, `board.view().events expected > 1 event, got ${full.length} in src/crew/board/store.ts`)
assert.deepEqual(packed.events.map(event => event.seq), full.map(event => event.seq))
console.log('PASS 3 an explicit history read returns every event oldest first')
const readOnly = open(join(home, 'addressing.sqlite'), 'addressing', Date.now, true)
let changes = 0
const stop = readOnly.subscribe(() => changes++)
post('The store append reaches its read-only tail.')
assert(changes > 0, 'read-only SQLite subscriber was not notified on same-process post in src/crew/board/store.ts')
assert.equal(readOnly.view().events.at(-1)!.text, 'The store append reaches its read-only tail.')
assert.throws(() => readOnly.enroll(principal('writer')), /cannot write/)
stop()
await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => { unsubscribe(); reject(new Error('The WAL append did not reach its reader')) }, 5000)
  const unsubscribe = readOnly.subscribe(() => {
    if (readOnly.view().events.at(-1)?.text !== 'A different process appended this.') return
    clearTimeout(deadline); unsubscribe(); resolve()
  })
  const child = spawn(process.execPath, ['-e', `import { open } from ${JSON.stringify(new URL('../../src/crew/board/store.ts', import.meta.url).href)}; const b = open(${JSON.stringify(join(home, 'addressing.sqlite'))}, 'addressing'); const r = b.post(${JSON.stringify(alpha)}, { clientOpId: 'cross-process', kind: 'result', text: 'A different process appended this.' }); b.close(); if (!r.ok) process.exit(1);`], { stdio: 'ignore', env: process.env })
  child.on('error', reject)
  child.on('exit', code => { if (code !== 0) { clearTimeout(deadline); unsubscribe(); reject(new Error(`writer exited ${code}`)) } })
})
readOnly.close(); board.close()
console.log('PASS same-process and cross-process committed appends notify a read-only SQLite tail')
