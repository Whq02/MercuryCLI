import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { boardNamesSeat, boardWakeEligible, matchesBoardWait, parseBoardWait, type BoardWait } from '../../src/services/crewBoard/waits.ts'
import { boardReachNote, boardReachWords, type BoardEvent, type BoardPrincipal, type BoardSeat } from '../../src/services/crewBoard/contracts.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
let checks = 0
const check = (label: string, value: unknown): void => { assert(value, label); checks++; console.log(`PASS ${label}`) }

const reader: BoardSeat = { agent: 'reader', name: 'Reader', team: 'engine' }
const writer: BoardSeat = { agent: 'writer', name: 'Writer', team: 'engine' }
const seats = [reader, writer]
const event = (extra: Partial<BoardEvent> & { addresses?: string[]; recipients?: BoardSeat[] } = {}): BoardEvent & { addresses: string[]; recipients?: BoardSeat[] } => ({
  schema: 1 as const, boardId: 'board', waveId: 'wave', eventId: 'posted', clientOpId: 'post', seq: 11,
  author: { sessionId: 'session', agentId: 'main', executionId: 'run' }, authorName: 'main',
  kind: 'result' as const, text: 'OPERATOR RESUME', addresses: [], mentions: [], relatedTasks: [], files: [], refs: [],
  createdAt: '2026-01-01T00:00:00.000Z', payloadDigest: '0'.repeat(64), threadId: 'thread', policyRevision: 1 as const, ...extra,
})
const byKind: BoardWait = { eventId: 'declared', seq: 10, version: 1, predicate: parseBoardWait({ kind: 'ask', text: '@main wake me when kind result' }, reader, seats)!, standing: false }

check('a seat named beside @all is still a named seat', boardNamesSeat(event({ addresses: ['Reader', 'all'], recipients: [reader, writer] }), reader) && boardNamesSeat(event({ addresses: ['all', 'reader'], recipients: [reader, writer] }), reader))
check('@all on its own names nobody', !boardNamesSeat(event({ addresses: ['all'], recipients: [reader, writer] }), reader) && !boardNamesSeat(event({ addresses: ['all', 'Reader'], recipients: [reader, writer] }), writer))
check('a broadcast never satisfies a declared wait, named seats beside it or not', !matchesBoardWait(event({ addresses: ['all'] }), byKind, reader.agent) && !matchesBoardWait(event({ addresses: ['all', 'Writer'] }), byKind, reader.agent) && matchesBoardWait(event({ addresses: ['Writer'] }), byKind, reader.agent))
check('eligibility still refuses main, the author, lifecycle rows and the general channel', !boardWakeEligible(event(), 'main') && !boardWakeEligible(event({ author: { sessionId: 'session', agentId: reader.agent, executionId: 'run' } }), reader.agent) && !boardWakeEligible(event({ authorRole: 'system' } as never), reader.agent) && !boardWakeEligible(event({ channel: { kind: 'general' } } as never), reader.agent))

const { open } = await import('../../src/services/crewBoard/store.ts')
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'post-reach-'))
let now = 0
const sessionId = 'post-reach'
const board = open(join(home, 'board.sqlite'), sessionId, () => now += 15000)
const seat = (agentId: string, name: string, team?: string): BoardPrincipal => ({ author: { sessionId, agentId, executionId: 'run' }, name, team })
const main = seat('main', 'main')
const captain = seat('captain-id', 'Captain', 'world')
const battle = seat('battle-id', 'Battle', 'world')
const world = seat('world-id', 'World', 'world')
const other = seat('other-id', 'Other', 'art')
for (const principal of [main, captain, battle, world, other]) board.enroll(principal)
assert(board.assignCaptain(main, 'world', 'captain-id').ok)
for (const principal of [captain, battle, world]) board.complete(principal, 'completed')
board.complete(other, 'stopped')
const wakesOf = (eventId: string): string[] => board.pendingWakes().filter(wake => wake.eventId === eventId).map(wake => wake.agent).sort()

const relay = board.post(main, { clientOpId: 'relay', kind: 'result', text: '@Captain @Battle @Other @all OPERATOR RESUME relayed by main' })
assert(relay.ok)
check('the operator-resume relay wakes the parked seats it names although @all rides beside them', JSON.stringify(wakesOf(relay.eventId)) === JSON.stringify(['battle-id', 'captain-id']))
check('@all beside the names wakes no other parked seat, not even through the captain’s standing team wait', !wakesOf(relay.eventId).includes('world-id'))
check('the receipt says who will act: the wakes queued, the named seat that cannot wake, the parked rest', relay.reach !== undefined && JSON.stringify(relay.reach) === JSON.stringify({ running: [], wakes: ['Captain', 'Battle'], held: ['Other'], parked: 1 }))
check('a stopped seat named in the post is reported held with the ResumeCrewmate road', relay.note !== undefined && relay.note.startsWith('Other is named but cannot be woken by a post') && relay.note.includes('ResumeCrewmate'))

const broadcast = board.post(main, { clientOpId: 'broadcast', kind: 'result', text: '@all status: the hold is lifted' })
assert(broadcast.ok)
check('@all alone wakes nobody and the receipt says so, with the count of parked seats it reached', wakesOf(broadcast.eventId).length === 0 && JSON.stringify(broadcast.reach) === JSON.stringify({ running: [], wakes: [], held: [], parked: 4 }) && broadcast.note !== undefined && broadcast.note.startsWith('Nobody will act on this post') && broadcast.note.includes('@all alone wakes nobody') && broadcast.note.includes('ResumeCrewmate'))
check('the screen row carries the same verdict', boardReachWords(broadcast.reach!) === 'nobody running, no wake · 4 parked' && boardReachWords(relay.reach!) === '2 wakes · 1 held')

board.enroll(seat('runner-id', 'Runner', 'art'))
const ask = board.post(main, { clientOpId: 'ask', kind: 'ask', text: '@Runner which file owns the legend?' })
assert(ask.ok)
check('a post to a running seat reports it running and carries no note', JSON.stringify(ask.reach) === JSON.stringify({ running: ['Runner'], wakes: [], held: [], parked: 0 }) && ask.note === undefined && boardReachWords(ask.reach!) === '1 running')
const again = board.post(main, { clientOpId: 'ask', kind: 'ask', text: '@Runner which file owns the legend?' })
check('a replay of the same retry key is still a replay', again.ok && again.replay === true)
const answer = board.post(seat('runner-id', 'Runner', 'art'), { clientOpId: 'answer', kind: 'answer', replyTo: ask.eventId, text: 'legend.ts owns it' })
assert(answer.ok)
check('an answer to a running asker reaches the asker', JSON.stringify(answer.reach) === JSON.stringify({ running: ['main'], wakes: [], held: [], parked: 0 }))
const mirrored = board.post(main, { clientOpId: 'notice', kind: 'notice', text: 'Crewmate "Other" completed', taskId: 'other-id' }, 'mirror')
check('a mirrored notice carries no reach', mirrored.ok && !('reach' in mirrored))
check('the note words are composed from the reach alone', boardReachNote({ running: [], wakes: [], held: ['A', 'B'], parked: 0 })!.endsWith('A, B are named but cannot be woken by a post (stopped, paused or already resuming) — ResumeCrewmate restarts a stopped seat.') && boardReachNote({ running: ['X'], wakes: [], held: [], parked: 9 }) === undefined)
board.close()
console.log(`prove-swarm-post-reach: ${checks} checks`)
