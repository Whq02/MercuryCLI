import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { open } from '../../src/services/crewBoard/store.ts'
import type { BoardPost, BoardPrincipal, BoardReceipt } from '../../src/services/crewBoard/contracts.ts'
import type { BoardWake } from '../../src/services/crewBoard/wakeState.ts'

const sessionId = 'contention'
const instant = 1_800_000_000_000
const limits = { seatAllowance: 0, waveAllowance: 0, postChars: 0, postsPerMinute: 1000, postsPerSeat: 1000 }
const seat = (agentId: string, executionId = 'first', team?: string): BoardPrincipal => ({ author: { sessionId, agentId, executionId }, name: agentId, team })
const main = seat('main'), reader = seat('reader'), writers = ['alpha', 'beta', 'gamma'].map(agent => seat(agent, 'first', 'builders'))
type Operation = { id: number; op: 'post'; author: BoardPrincipal; post: BoardPost } | { id: number; op: 'boundary'; seen: string[] } | { id: number; op: 'claim'; wake: BoardWake } | { id: number; op: 'captain' }
const workerAt = process.argv.indexOf('--worker')
if (workerAt >= 0) {
  const board = open(process.argv[workerAt + 1]!, sessionId, limits, () => instant)
  console.log(JSON.stringify({ ready: true }))
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as Operation
    console.log(JSON.stringify({ entered: command.id }))
    try {
      const value = command.op === 'post' ? board.post(command.author, command.post)
        : command.op === 'boundary' ? board.boundary(reader, new Set(command.seen))
        : command.op === 'claim' ? board.claimWake(main, command.wake)
        : board.assignCaptain(main, 'builders', 'alpha')
      console.log(JSON.stringify({ id: command.id, value }))
    } catch (error) { console.log(JSON.stringify({ id: command.id, error: String(error) })) }
  }
  board.close()
} else {
  assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
  const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'contention-'))
  const path = join(home, 'board.sqlite')
  const board = open(path, sessionId, limits, () => instant)
  for (const principal of [main, reader, ...writers]) board.enroll(principal)
  type Command = Operation extends infer O ? O extends Operation ? Omit<O, 'id'> : never : never
  const worker = () => {
    const child = spawn(process.execPath, [import.meta.filename, '--worker', path], { stdio: ['pipe', 'pipe', 'pipe'] })
    let serial = 0, stderr = ''
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const waiting = new Map<number, { enter(): void; resolve(value: any): void; reject(error: Error): void }>()
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      const row = JSON.parse(line)
      if (row.ready) { ready(); return }
      if (row.entered !== undefined) { waiting.get(row.entered)?.enter(); return }
      const pending = waiting.get(row.id)
      assert(pending, `unexpected worker response: ${line}`)
      waiting.delete(row.id)
      if (row.error) pending.reject(new Error(row.error))
      else pending.resolve(row.value)
    })
    const exited = new Promise<void>((resolve, reject) => child.once('exit', code => {
      for (const pending of waiting.values()) pending.reject(new Error(`worker exited ${code}: ${stderr}`))
      code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))
    }))
    const send = (command: Command) => {
      const id = ++serial
      let enter!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const result = new Promise<any>((resolve, reject) => { waiting.set(id, { enter, resolve, reject }) })
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
      return { entered, result }
    }
    return { started, send, async close() { child.stdin.end(); await exited; lines.close() } }
  }
  const workers = [worker(), worker(), worker()]
  const lock = new (createRequire(import.meta.url)('bun:sqlite').Database)(path) as { exec(sql: string): void; inTransaction: boolean; close(): void }
  let serial = 0
  const post = (author: BoardPrincipal, text: string, to = ['reader'], kind: BoardPost['kind'] = 'result'): Command => ({ op: 'post', author, post: { clientOpId: `p-${++serial}`, kind, text, to } })
  const receipts = (rows: BoardReceipt[]) => rows.map(row => { assert(row.ok, JSON.stringify(row)); return row })
  const events = () => board.screenEvents(0)
  const take = () => {
    const packet = board.boundary(reader, new Set())
    if (packet) board.presented(reader, packet.eventIds, `read-${++serial}`)
    return packet?.eventIds ?? []
  }
  const expectedIds = (rows: { eventId: string; seq: number }[]) => [...rows].sort((a, b) => a.seq - b.seq).map(row => row.eventId)
  try {
    await Promise.all(workers.map(worker => worker.started))
    lock.exec('BEGIN IMMEDIATE')
    const locked = workers.map((worker, i) => worker.send(post(writers[i]!, `same millisecond ${i}`)))
    await Promise.all(locked.map(call => call.entered))
    let completed = 0
    const results = locked.map(call => call.result.then(value => { completed++; return value }))
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(completed, 0, 'all three writers must encounter the held write lock')
    lock.exec('COMMIT')
    const first = receipts(await Promise.all(results))
    assert.equal(new Set(first.map(row => row.seq)).size, 3)
    assert.deepEqual(take(), expectedIds(first))
    assert.equal(take().length, 0)
    assert(events().filter(event => first.some(row => row.eventId === event.eventId)).every(event => event.createdAt === new Date(instant).toISOString()))
    console.log('PASS three locked writers commit same-millisecond posts once in SQLite sequence')

    const retry = post(writers[0]!, 'retry under contention')
    const retried = receipts(await Promise.all(workers.map(worker => worker.send(retry).result)))
    assert.equal(new Set(retried.map(row => row.eventId)).size, 1)
    assert.equal(retried.filter(row => !row.replay).length, 1)
    assert.deepEqual(take(), [retried[0]!.eventId])
    console.log('PASS concurrent identical retries retain one committed identity and one delivery')

    for (let i = 0; i < 12; i++) {
      const calls = [workers[0]!.send(post(writers[0]!, `before boundary ${i}`)), workers[1]!.send(post(writers[1]!, `beside boundary ${i}`)), workers[2]!.send({ op: 'boundary', seen: [] })]
      const [a, b, packet] = await Promise.all(calls.map(call => call.result))
      const posted = receipts([a, b])
      const ids: string[] = packet?.eventIds ?? []
      if (packet) board.presented(reader, ids, `boundary-${i}`)
      const rest = take()
      assert.deepEqual([...ids, ...rest], expectedIds(posted))
      assert.equal(take().length, 0)
    }
    console.log('PASS a boundary racing two writers neither skips nor repeats the later commit')

    for (let i = 0; i < 8; i++) {
      const waiter = seat('reader', `wait-${i}`)
      board.enroll(waiter)
      const declare = { op: 'post' as const, author: waiter, post: { clientOpId: `wait-${i}`, kind: 'ask' as const, text: '@main wake me when about ready-row' } }
      const match = post(writers[0]!, `matched ${i}`, [], 'result')
      assert(match.op === 'post')
      match.post.about = 'ready-row'
      const [arm, trigger] = receipts(await Promise.all([workers[0]!.send(declare).result, workers[1]!.send(match).result]))
      board.complete(waiter, 'completed')
      const wake = board.pendingWakes().find(wake => wake.agent === 'reader')
      assert.equal(wake?.eventId, trigger!.seq > arm!.seq ? trigger!.eventId : undefined)
      const next = trigger!.seq > arm!.seq ? trigger! : receipts([board.post(writers[0]!, { clientOpId: `after-arm-${i}`, kind: 'result', text: `after arm ${i}`, about: 'ready-row' })])[0]!
      const candidate = board.pendingWakes().find(wake => wake.agent === 'reader')!
      assert.equal(candidate.eventId, next.eventId)
      const claims = await Promise.all(workers.slice(0, 2).map(worker => worker.send({ op: 'claim', wake: candidate }).result))
      assert.equal(claims.filter(Boolean).length, 1)
      const claim = claims.find(Boolean)!
      const packet = board.wakePacket(main, claim)!
      assert(packet.eventIds.includes(next.eventId))
      const later = board.post(writers[1]!, { clientOpId: `second-match-${i}`, kind: 'result', text: `second matching post ${i}`, about: 'ready-row' })
      assert(later.ok)
      const resumed = seat('reader', `resume-${i}`)
      board.enroll(resumed)
      board.admitWake(main, claim)
      board.admitWake(main, claim)
      board.presented(resumed, packet.eventIds, `wake-${i}`)
      const tail = board.boundary(resumed, new Set())!
      assert(tail.eventIds.includes(later.eventId))
      assert(!tail.eventIds.includes(next.eventId))
      board.presented(resumed, tail.eventIds, `second-${i}`)
      board.complete(resumed, 'completed')
      assert.equal(board.pendingWakes().filter(wake => wake.agent === 'reader').length, 0)
      assert.equal(board.view().peerTurns, i + 1)
    }
    console.log('PASS an arm and matching post serialize; competing claims resume once with that match, retaining a second post')

    const parked = seat('reader', 'broadcast')
    board.enroll(parked)
    assert(board.post(parked, { clientOpId: 'broadcast-wait', kind: 'ask', text: '@main wake me when kind result' }).ok)
    board.complete(parked, 'completed')
    const mixed = receipts(await Promise.all([workers[0]!.send(post(writers[0]!, 'broadcast only', ['all'])).result, workers[1]!.send(post(writers[1]!, 'addressed wake', ['reader'])).result]))
    const wakes = board.pendingWakes().filter(wake => wake.agent === 'reader')
    assert.deepEqual(wakes.map(wake => wake.eventId), [mixed[1]!.eventId])
    const claim = board.claimWake(main, wakes[0]!)!
    const packet = board.wakePacket(main, claim)!
    assert.deepEqual(packet.eventIds, expectedIds(mixed))
    assert.equal(new Set(packet.eventIds).size, 2)
    console.log('PASS interleaved broadcast and addressed traffic stay ordered; only the addressed match wakes')

    board.complete(writers[0]!, 'completed')
    const [appointment, traffic] = await Promise.all([workers[0]!.send({ op: 'captain' }).result, workers[1]!.send(post(writers[1]!, 'team during appointment', ['builders'])).result])
    assert(appointment.ok)
    assert(traffic.ok)
    const captain = board.captain('builders')!
    assert.equal(captain.agent, 'alpha')
    const teamWake = board.pendingWakes().filter(wake => wake.agent === 'alpha')
    assert.equal(teamWake.length, traffic.seq > captain.wait!.seq ? 1 : 0)
    if (teamWake.length) assert.equal(teamWake[0]!.eventId, traffic.eventId)
    const body = board.boundary(writers[0]!, new Set())!
    assert.equal(body.eventIds.filter(id => id === traffic.eventId).length, 1)
    console.log('PASS captain appointment and team traffic share one serialization point without duplicate fanout')
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK')
    lock.close()
    await Promise.all(workers.map(worker => worker.close()))
    board.close()
    rmSync(home, { recursive: true, force: true })
  }
}
