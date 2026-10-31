import assert from 'node:assert/strict'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import { DEFAULT_BOARD_LIMITS, type BoardLimits, type BoardPost, type BoardStore } from '../../src/services/crewBoard/contracts.ts'

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
function world(id: string, patch: Partial<BoardLimits> = {}) {
  let time = 0, serial = 0
  const limits = { ...DEFAULT_BOARD_LIMITS, ...patch }
  const path = join(home!, `${id}.sqlite`)
  const board = open(path, id, limits, () => time)
  boards.push(board)
  const seat = (agentId: string) => {
    const p = { author: { sessionId: id, agentId, executionId: 'run' }, name: agentId }
    board.enroll(p)
    return p
  }
  const main = seat('main')
  const author = seat('author')
  const post = (text: string, extra: Partial<BoardPost> = {}, delivery: 'body' | 'index' = 'index') => {
    time += 15000
    const result = board.post(author, { clientOpId: `post-${++serial}`, kind: 'result', text, ...extra }, delivery)
    assert(result.ok, JSON.stringify(result))
    return result
  }
  return { board, main, author, seat, post, path, advance: () => { time += 15000 } }
}
try {
  check('the defaults are no cap: seat, wave and post length at 0; the loop guards at 4 a minute and 120 a seat', DEFAULT_BOARD_LIMITS.seatAllowance === 0 && DEFAULT_BOARD_LIMITS.waveAllowance === 0 && DEFAULT_BOARD_LIMITS.postChars === 0 && DEFAULT_BOARD_LIMITS.postsPerMinute === 4 && DEFAULT_BOARD_LIMITS.postsPerSeat === 120)
  const history = world('history')
  const early = history.seat('early')
  for (let i = 0; i < 60; i++) history.post(`Finding ${i}`)
  const first = handed(history.board, early, {})
  const admitted = history.board.view().admitted
  const twice = handed(history.board, early, {})
  check('a seat reads twice and pays once', first.events.length === 60 && first.tokens > 0 && twice.events.length === 0 && twice.tokens === 0 && history.board.view().admitted === admitted)
  check('the receipt names skipped seen events and the re-read road', twice.skippedSeen === 60 && twice.reread.includes('since: 0'))
  const late = history.seat('late')
  check('a seat enrolled after sixty events reads no history by default', handed(history.board, late, {}).events.length === 0)
  const reread = handed(history.board, late, { since: 0 })
  check('since zero deliberately reads all sixty earlier events', reread.events.length === 60 && reread.tokens > 0 && reread.skippedSeen === 0)
  check('a seen event never blocks an explicit re-read', handed(history.board, early, { since: 0 }).tokens === first.tokens)
  history.board.close()
  const again = open(history.path, 'history')
  boards.push(again)
  check('seen state and cursor survive reopening', again.read(early, {}).events.length === 0 && again.read(late, {}).events.length === 0)

  const delivery = world('delivery')
  const receiver = delivery.seat('receiver')
  const whole = delivery.post('Read the boundary.', { kind: 'message', to: ['receiver'] }, 'body')
  const packet = delivery.board.boundary(receiver, new Set())!
  check('preparing a boundary is retry-safe', packet.text.includes('Read the boundary.') && JSON.stringify(delivery.board.boundary(receiver, new Set())) === JSON.stringify(packet))
  delivery.board.presented(receiver, packet.eventIds, 'sent')
  const skipped = handed(delivery.board, receiver, {})
  check('a whole presented boundary event is skipped by the next read', skipped.events.length === 0 && skipped.skippedSeen === 1 && skipped.tokens === 0)
  check('a whole boundary event is still explicitly re-readable', handed(delivery.board, receiver, { since: whole.seq - 1 }).events[0]?.eventId === whole.eventId)
  const indexed = delivery.post('An indexed finding.', { to: ['receiver'] })
  const index = delivery.board.boundary(receiver, new Set())!
  delivery.board.presented(receiver, index.eventIds, 'indexed')
  check('an id-only boundary does not mark the body seen', handed(delivery.board, receiver, {}).events[0]?.eventId === indexed.eventId)

  const trunc = world('truncation')
  const small = trunc.seat('small')
  const long = trunc.post('A quote " and emoji 😀. '.repeat(80))
  const partial = handed(trunc.board, small, { limitTokens: 1 })
  check('a truncated entry is charged but keeps the cursor before it', partial.events[0]?.eventId === long.eventId && 'truncated' in partial.events[0]! && partial.cursor < long.seq && partial.tokens > 1)
  const complete = handed(trunc.board, small, {})
  check('the next default read serves the truncated event whole', complete.events[0]?.eventId === long.eventId && !('truncated' in complete.events[0]!))
  check('after the full read it is seen', handed(trunc.board, small, {}).events.length === 0)
  const other = trunc.post('Other topic', { taskId: 'other' })
  const selected = trunc.post('Selected topic', { taskId: 'selected' })
  assert.equal(handed(trunc.board, small, { task: 'selected' }).events[0]?.eventId, selected.eventId)
  check('filtered reads do not skip unseen earlier topics', handed(trunc.board, small, {}).events[0]?.eventId === other.eventId)

  for (const allowance of [1000, 200000, 5000000, 0]) {
    const w = world(`allowance-${allowance}`, { seatAllowance: allowance, waveAllowance: 0 })
    const p = w.seat('reader')
    w.post('A finding')
    const page = handed(w.board, p, {})
    if (allowance === 1000) w.board.setUncapped(w.main, true)
    const replay = handed(w.board, p, { since: 0 })
    check(`explicit re-reading works with seat allowance ${allowance}`, replay.events.length === 1 && replay.tokens === page.tokens)
  }
  const zero = world('zero', { seatAllowance: 0, waveAllowance: 0, postChars: 0 })
  const unlimited = zero.seat('reader')
  zero.post('x'.repeat(450000))
  const large = handed(zero.board, unlimited, {})
  check('zero permits more than 400k of requested context without a refusal', large.tokens > 400000 && !large.reason && !('truncated' in large.events[0]!))
  check('zero permits a deliberate large re-read too', handed(zero.board, unlimited, { since: 0 }).tokens === large.tokens)

  const pendingRead = world('pending-read')
  const waiting = pendingRead.seat('waiting')
  const unsent = pendingRead.post('This result has not reached the model yet.')
  const prepared = pendingRead.board.read(waiting, {})
  check('a prepared read is not seen until handed to the model', pendingRead.board.read(waiting, {}).events[0]?.eventId === unsent.eventId)
  pendingRead.board.presented(waiting, [], 'read-arrived', [prepared.packetId!])
  check('presentation marks a whole read seen', handed(pendingRead.board, waiting, {}).events.length === 0)

  const degraded = world('degraded', { seatAllowance: 2000, waveAllowance: 2000, postChars: 0 })
  const filling = degraded.seat('filling'), notified = degraded.seat('notified')
  degraded.post('x'.repeat(5000))
  handed(degraded.board, filling, { limitTokens: 1700 })
  const body = 'y'.repeat(200)
  const message = degraded.post(body, { kind: 'message', threadId: 'short', to: ['notified'] }, 'body')
  const reduced = degraded.board.boundary(notified, new Set())!
  check('unsolicited body degrades to an index when that still fits', reduced.eventIds.includes(message.eventId) && !reduced.text.includes(body))
  degraded.board.presented(notified, reduced.eventIds, 'reduced')
  check('the degraded body stays available to an explicit read', handed(degraded.board, notified, { thread: 'short' }).events[0]?.text === body)
  handed(degraded.board, degraded.main, { since: 0 })
  const noticeCost = degraded.board.view().admitted
  const guardedNotice = degraded.board.boundary(degraded.main, new Set())
  check('cap notices reach even a spent lead without a context charge', guardedNotice?.text.includes('swarm.waveAllowance') && degraded.board.view().admitted === noticeCost)

  const active = world('live-members', { seatAllowance: 10000, waveAllowance: 10000, postChars: 0 })
  const a = active.seat('a'), b = active.seat('b'), c = active.seat('c'), d = active.seat('d')
  active.post('x'.repeat(8000), { threadId: 'large' })
  const pa = handed(active.board, a, {}), pb = handed(active.board, b, {})
  check('a wave cap does not refuse a seat’s own read', pa.tokens > 8000 && pb.tokens > 8000 && !pb.reason && active.board.view().admitted > 10000)
  const delayed = active.post('An unsolicited body', { kind: 'message', threadId: 'small', to: ['d'] }, 'body')
  check('unsolicited delivery yields when the wave is full', active.board.boundary(d, new Set()) === null)
  const ownerNotice = active.board.boundary(active.main, new Set())!
  check('the lead gets the seat, allowance and uncap road', ownerNotice.text.includes('d:') && ownerNotice.text.includes('swarm.waveAllowance') && ownerNotice.text.includes('/swarm uncap'))
  active.board.presented(active.main, ownerNotice.eventIds, 'notice')
  active.board.boundary(d, new Set())
  check('only one notice is issued per seat and allowance', active.board.boundary(active.main, new Set()) === null)
  const requested = handed(active.board, c, { thread: 'small' })
  check('a requested read still works after delivery was held', requested.events[0]?.eventId === delayed.eventId && !requested.reason)
  const beforeSettle = active.board.view().admitted
  active.board.settle(a); active.board.settle(b)
  check('completed seats stop counting against the wave', active.board.view().admitted === beforeSettle - pa.tokens - pb.tokens)
  check('freed wave room lets the pending body through', active.board.boundary(d, new Set())?.text.includes('An unsolicited body'))
  active.board.enroll(a)
  check('a resumed seat counts again without resetting its own charges', active.board.view().admitted >= pa.tokens + requested.tokens)
  handed(active.board, a, { since: 0, thread: 'large' })
  const held = handed(active.board, a, { since: 0, thread: 'large' })
  check('a spent seat names its allowance and the lead’s uncap road', held.events.length === 0 && held.reason?.includes('swarm.seatAllowance') && held.reason.includes('/swarm uncap'))
  assert.throws(() => active.board.setUncapped(a, true), /Only the lead/)
  active.board.setUncapped(active.main, true)
  const lifted = handed(active.board, a, { since: 0 })
  check('uncap lifts all context gates at run time', lifted.tokens > 8000 && !lifted.reason && active.board.uncapped)
  const shared = open(active.path, 'live-members')
  boards.push(shared)
  check('another store sees the wave override immediately', shared.uncapped && shared.read(a, { since: 0 }).tokens > 8000)
  shared.setUncapped(active.main, false)
  check('cap restores the original spent seat limit', !active.board.uncapped && handed(active.board, a, { since: 0 }).events.length === 0)

  const lengths = world('lengths', { postChars: 4000 })
  check('3000 characters lands under a 4,000 cap', lengths.board.post(lengths.author, { clientOpId: '3000', kind: 'result', text: 'x'.repeat(3000) }).ok)
  const tooLong = lengths.board.post(lengths.author, { clientOpId: '4001', kind: 'result', text: 'x'.repeat(4001) })
  check('4001 refuses with the setting, limit and uncap road', !tooLong.ok && tooLong.reason.includes('4,000') && tooLong.reason.includes('swarm.postChars') && tooLong.reason.includes('/swarm uncap'))
  lengths.board.setUncapped(lengths.main, true)
  check('uncap lifts post length too', lengths.board.post(lengths.author, { clientOpId: '4001', kind: 'result', text: 'x'.repeat(4001) }).ok)
  check('the view carries the live override with its snapshot', lengths.board.view().uncapped === true)
  lengths.board.setUncapped(lengths.main, false)
  const retry = lengths.board.post(lengths.author, { clientOpId: '4001', kind: 'result', text: 'x'.repeat(4001) })
  check('restoring caps preserves an identical successful retry', retry.ok && retry.replay)
  check('the view carries the restored cap', lengths.board.view().uncapped === false)
  check('cap restores post length', !lengths.board.post(lengths.author, { clientOpId: '4002', kind: 'result', text: 'x'.repeat(4001) }).ok)
  const notice = lengths.board.boundary(lengths.main, new Set())!
  check('repeated post-length refusals have one lead notice', notice.eventIds.length === 1 && notice.text.includes('swarm.postChars'))
  lengths.board.presented(lengths.main, notice.eventIds, 'length-notice')
  check('a presented lead notice is not sent again', lengths.board.boundary(lengths.main, new Set()) === null)
  const loops = world('loops', { postsPerSeat: 10 })
  loops.board.setUncapped(loops.main, true)
  for (let i = 0; i < 8; i++) assert(loops.board.post(loops.author, { clientOpId: `burst-${i}`, kind: 'result', text: 'x' }).ok)
  check('uncap never lifts the post-rate loop guard', !loops.board.post(loops.author, { clientOpId: 'ninth', kind: 'result', text: 'x' }).ok)
  for (let i = 8; i < 10; i++) { loops.advance(); assert(loops.board.post(loops.author, { clientOpId: `extra-${i}`, kind: 'result', text: 'x' }).ok) }
  loops.advance()
  check('uncap never lifts the post-count loop guard', !loops.board.post(loops.author, { clientOpId: 'eleventh', kind: 'result', text: 'x' }).ok)
  console.log(`${checks} seen-once and cap checks passed`)
} finally {
  for (const board of boards) board.close()
}
