import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { open } from '../../src/services/crewBoard/store.ts'

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
assert.equal(board.boundary(gamma, new Set()), null)
console.log('PASS 1–2 unknown mentions land as plain posts; results and blockers need no task or evidence')
post('An independent blocker.', { kind: 'blocker' })
const direct = post('@Gamma please read this.')
assert(board.boundary(gamma, new Set())?.eventIds.includes(direct.eventId))
assert(!board.boundary(delta, new Set())?.eventIds.includes(direct.eventId))
const team = post('A view question.', { to: ['view'] })
assert(board.boundary(gamma, new Set([direct.eventId]))?.eventIds.includes(team.eventId))
const all = post('@all read the common finding.')
for (const seat of [lead, beta, gamma, delta]) assert(board.boundary(seat, new Set())?.eventIds.includes(all.eventId) || board.boundary(seat, new Set([direct.eventId, team.eventId]))?.eventIds.includes(all.eventId))
const priority = board.boundary(beta, new Set())!
assert.equal(priority.eventIds[0], all.eventId, 'mentions precede older team delivery')
assert(board.boundary(beta, new Set([all.eventId]))?.eventIds.includes(unknown.eventId), 'team receives unmentioned posts')
board.read(gamma, { team: 'engine', since: board.view().snapshot, watch: true })
const interest = post('A team subscription receives this without a mention.')
assert(board.boundary(gamma, new Set([direct.eventId, team.eventId, all.eventId]))?.eventIds.includes(interest.eventId))
board.read(delta, { files: ['parser.ts'], watch: true })
const relevance = post('A relevant file finding.', { files: ['parser.ts'] })
assert(board.boundary(delta, new Set([all.eventId]))?.eventIds.includes(relevance.eventId))
assert.equal(board.assignTeam(beta, 'Gamma', 'engine').ok, false)
assert.equal(board.assignTeam(lead, 'Gamma', 'engine').ok, true)
assert.equal(board.assignTeam(lead, 'Gamma', 'all').ok, false)
assert.equal(board.read(delta, { team: 'view' }).events.length, 0)
assert(board.read(delta, {}).events.some(event => event.eventId === unknown.eventId), 'general is visible across teams')
assert(board.view(undefined, undefined, 'engine').events.every(event => event.team === 'engine'))
assert.equal(board.view(undefined, undefined, 'view').events.length, 0)
console.log('PASS 4–6 text and to address seats, teams and all; mention priority, relevance, subscriptions and public team channels')
const reader = principal('reader')
board.enroll(reader)
const full = board.view().events
const costs = full.map(event => Buffer.byteLength(JSON.stringify(event)))
const allowance = 6000
let expected = 0
let used = 0
for (const cost of costs) { if (used + cost > allowance) break; expected++; used += cost }
const packed = board.read(reader, {})
assert(expected > 1)
assert.equal(packed.events.length, expected)
assert.equal(packed.tokens, used)
assert.equal(packed.omitted, full.length - expected)
assert.deepEqual(packed.events.map(event => event.seq), full.slice(0, expected).map(event => event.seq))
const tinyReader = principal('tiny')
board.enroll(tinyReader)
const tiny = board.read(tinyReader, { limitTokens: 1 })
assert.equal(tiny.events.length, 1)
assert.equal(tiny.events[0]!.eventId, unknown.eventId)
assert.equal('truncated' in tiny.events[0]!, true)
assert.equal(tiny.tokens, Buffer.byteLength(JSON.stringify(tiny.events[0])))
assert.equal(tiny.omitted, full.length - 1)
const narrow = board.read(tinyReader, { since: tiny.cursor, limitTokens: costs[1]! + costs[2]! })
assert.equal(narrow.events.length, 2)
assert.equal(narrow.omitted, full.length - 3)
console.log('PASS 3 default reads fill the remaining allowance oldest first; tiny budgets return a charged identity envelope')
const readOnly = open(join(home, 'addressing.sqlite'), 'addressing', Date.now, true)
let changes = 0
const stop = readOnly.subscribe(() => changes++)
post('The store append reaches its read-only tail.')
assert(changes > 0)
assert.equal(readOnly.view().events.at(-1)!.text, 'The store append reaches its read-only tail.')
assert.throws(() => readOnly.enroll(principal('writer')), /cannot write/)
stop()
await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => { unsubscribe(); reject(new Error('The WAL append did not reach its reader')) }, 5000)
  const unsubscribe = readOnly.subscribe(() => {
    if (readOnly.view().events.at(-1)?.text !== 'A different process appended this.') return
    clearTimeout(deadline); unsubscribe(); resolve()
  })
  const child = spawn(process.execPath, ['-e', `import { open } from ${JSON.stringify(new URL('../../src/services/crewBoard/store.ts', import.meta.url).pathname)}; const b = open(${JSON.stringify(join(home, 'addressing.sqlite'))}, 'addressing'); const r = b.post(${JSON.stringify(alpha)}, { clientOpId: 'cross-process', kind: 'result', text: 'A different process appended this.' }); b.close(); if (!r.ok) process.exit(1);`], { stdio: 'ignore', env: process.env })
  child.on('error', reject)
  child.on('exit', code => { if (code !== 0) { clearTimeout(deadline); unsubscribe(); reject(new Error(`writer exited ${code}`)) } })
})
readOnly.close(); board.close()
console.log('PASS same-process and cross-process committed appends notify a read-only SQLite tail without a polling timer')
