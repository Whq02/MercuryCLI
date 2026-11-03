import assert from 'node:assert/strict'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import type { BoardPost, BoardStore } from '../../src/services/crewBoard/contracts.ts'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
let checks = 0
const check = (label: string, value: unknown) => { assert(value, label); console.log(`PASS ${label}`); checks++ }
const boards: BoardStore[] = []
let request = 0
const handed = (board: BoardStore, seat: Parameters<BoardStore['read']>[0], input: Parameters<BoardStore['read']>[1]) => {
  const page = board.read(seat, input)
  board.presented(seat, [], `read-${++request}`, page.packetId ? [page.packetId] : [])
  return page
}
function world(id: string) {
  let time = 0, serial = 0
  const path = join(home!, `${id}.sqlite`)
  const board = open(path, id, () => time)
  boards.push(board)
  const seat = (agentId: string) => {
    const p = { author: { sessionId: id, agentId, executionId: 'run' }, name: agentId }
    board.enroll(p)
    return p
  }
  const main = seat('main')
  const author = seat('author')
  const post = (text: string, extra: Partial<BoardPost> = {}) => {
    time += 15000
    const result = board.post(author, { clientOpId: `post-${++serial}`, kind: 'result', text, ...extra })
    assert(result.ok, JSON.stringify(result))
    return result
  }
  return { board, main, author, seat, post, path }
}
try {
  const history = world('history')
  const early = history.seat('early')
  for (let i = 0; i < 60; i++) history.post(`Finding ${i}`)
  const first = handed(history.board, early, {})
  const twice = handed(history.board, early, {})
  check('a seat reads sixty events once and nothing the second time', first.events.length === 60 && twice.events.length === 0)
  check('the receipt names skipped seen events and the re-read road', twice.skippedSeen === 60 && twice.reread.includes('since: 0'))
  const late = history.seat('late')
  check('a seat enrolled after sixty events reads no history by default', handed(history.board, late, {}).events.length === 0)
  const reread = handed(history.board, late, { since: 0 })
  check('since zero deliberately reads all sixty earlier events', reread.events.length === 60 && reread.skippedSeen === 0)
  check('a seen event never blocks an explicit re-read', handed(history.board, early, { since: 0 }).events.length === 60)
  history.board.close()
  const again = open(history.path, 'history')
  boards.push(again)
  check('seen state and cursor survive reopening', again.read(early, {}).events.length === 0 && again.read(late, {}).events.length === 0)

  const delivery = world('delivery')
  const receiver = delivery.seat('receiver')
  const whole = delivery.post('Read the boundary.', { kind: 'message', to: ['receiver'] })
  const packet = delivery.board.boundary(receiver, new Set())!
  check('preparing a boundary is retry-safe', packet.text.includes('Read the boundary.') && JSON.stringify(delivery.board.boundary(receiver, new Set())) === JSON.stringify(packet))
  delivery.board.presented(receiver, packet.eventIds, 'sent')
  const skipped = handed(delivery.board, receiver, {})
  check('a presented boundary event is skipped by the next read', skipped.events.length === 0 && skipped.skippedSeen === 1)
  check('a boundary event is still explicitly re-readable', handed(delivery.board, receiver, { since: whole.seq - 1 }).events[0]?.eventId === whole.eventId)
  const plain = delivery.post('An unaddressed finding.')
  const everyone = delivery.board.boundary(receiver, new Set())!
  check('an unaddressed post arrives whole at the next boundary', everyone.eventIds.includes(plain.eventId) && everyone.text.includes('An unaddressed finding.'))
  delivery.board.presented(receiver, everyone.eventIds, 'plain')
  check('a presented unaddressed post is seen too', handed(delivery.board, receiver, {}).events.length === 0)

  const topics = world('topics')
  const small = topics.seat('small')
  const words = 'A quote " and emoji 😀. '.repeat(80)
  const long = topics.post(words)
  const complete = handed(topics.board, small, {})
  check('a long event is read whole', complete.events[0]?.eventId === long.eventId && complete.events[0]?.text === words)
  check('after the read it is seen', handed(topics.board, small, {}).events.length === 0)
  const other = topics.post('Other topic', { taskId: 'other' })
  const selected = topics.post('Selected topic', { taskId: 'selected' })
  assert.equal(handed(topics.board, small, { task: 'selected' }).events[0]?.eventId, selected.eventId)
  check('filtered reads do not skip unseen earlier topics', handed(topics.board, small, {}).events[0]?.eventId === other.eventId)

  const pendingRead = world('pending-read')
  const waiting = pendingRead.seat('waiting')
  const unsent = pendingRead.post('This result has not reached the model yet.')
  const prepared = pendingRead.board.read(waiting, {})
  check('a prepared read is not seen until handed to the model', pendingRead.board.read(waiting, {}).events[0]?.eventId === unsent.eventId)
  pendingRead.board.presented(waiting, [], 'read-arrived', [prepared.packetId!])
  check('presentation marks a read seen', handed(pendingRead.board, waiting, {}).events.length === 0)
  console.log(`${checks} seen-once checks passed`)
} finally {
  for (const board of boards) board.close()
}
