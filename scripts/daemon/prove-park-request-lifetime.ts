#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseAdmitResult, ConcourseWorkerRecordV1 } from '../../src/daemon/concourseWorkers.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'park-request-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const sup = await import('../../src/daemon/concourseWorkers.ts')
const { makeConcourseDispatchHandler } = await import('../../src/daemon/concourseDispatch.ts')
const { retiringRunners } = await import('./retiring-runners.ts')

const dir = process.env.MERCURY_DAEMON_DIR!
const DEAD_PID = 2_147_000_000
const now = Date.now()
const sid = (tail: string): string => `00000000-eeee-4000-8000-${tail.padStart(12, '0')}`
const GONE_WINDOW = `operator:${DEAD_PID}`
const THIS_WINDOW = `operator:${process.pid}`

function seedMidTurn(n: string): string {
  const runnerId = `concourse-w${n}`
  sup.updateConcourseWorkers(workers => {
    workers[runnerId] = {
      schema: 1,
      runnerId,
      sessionId: sid(n),
      workspaceId: SCRATCH,
      isolation: 'exclusive',
      modelKey: 'claude-sonnet-5',
      spawnedAt: now - 60_000,
      lastLiveAt: now - 60_000,
      pid: process.pid,
      lastDeliveryAt: now - 1_000,
      lastTurnSettledAt: now - 5_000,
    } as ConcourseWorkerRecordV1
  }, dir)
  return runnerId
}
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]
const j = (value: unknown): string => JSON.stringify(value)

const { killed, owes, held, dying, preparing, seat, askedOf, roster, leave: runnerLeft, close } = retiringRunners(sup, dir, DEAD_PID)
const quitWhileItWorks = (runnerId: string, by = GONE_WINDOW): void => {
  const receipt = sup.parkAllConcourseSessions(by, roster, dir, { exceptFocusedByLiveTerminal: true })
  if (!receipt.draining.includes(runnerId)) throw new Error(`the scene did not stage: ${runnerId} is not draining — ${j(receipt)}`)
}
const turnEnds = (runnerId: string): void => sup.markConcourseWorkerTurnSettled(runnerId, dir)
const retire = (sup as { retireRequestedPark?: typeof sup.retireRequestedPark }).retireRequestedPark
const idleEdge = async (runnerId: string): Promise<boolean> =>
  sup.completeRequestedPark(runnerId, roster, dir) || (retire !== undefined && (await retire(runnerId, roster, dir, { exitWaitMs: 2_000 })))

console.log("P0 the daemon's idle edge is what this proof walks: the record's own completion, then the runner's retirement")
{
  const main = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8')
  const edge = main.slice(main.indexOf('onIdle: short => {'), main.indexOf('onIdle: short => {') + 900)
  check('main.ts asks completeRequestedPark first and retireRequestedPark when that parked nothing', edge.indexOf('if (completeRequestedPark(short, roster)) {') !== -1 && edge.indexOf('retireRequestedPark(short, roster)') > edge.indexOf('if (completeRequestedPark(short, roster)) {'))
}

console.log('P1 nobody comes back: the session parks when its turn ends, by its own retirement')
{
  const w = seedMidTurn('1')
  seat(w)
  quitWhileItWorks(w)
  check('while the turn runs nothing parks and nothing is asked of the runner', !(await idleEdge(w)) && askedOf(w) === '' && killed.length === 0 && rec(w)?.parkedAt === undefined)
  turnEnds(w)
  const parked = await idleEdge(w)
  check('at the turn end it parks under the name that asked', parked && rec(w)?.parkedAt !== undefined && rec(w)?.parkedBy === GONE_WINDOW && rec(w)?.parkRequestedAt === undefined, j({ parked, rec: rec(w) }))
  check('…by its own retirement, prepare then commit, never a kill', askedOf(w) === 'prepare,commit' && killed.length === 0, j({ asked: askedOf(w), killed }))
  killed.length = 0
}

console.log('P2 a runner that still owes work is not parked: its queued words run first')
{
  const w = seedMidTurn('2')
  seat(w)
  quitWhileItWorks(w)
  owes.set(w, 'a prompt is queued')
  turnEnds(w)
  const early = await idleEdge(w)
  const standing = rec(w)
  check('the runner refuses with the work it owes; it is neither stopped nor parked', !early && killed.length === 0 && standing?.parkedAt === undefined && standing?.pid === process.pid, j({ early, killed, parkedAt: standing?.parkedAt }))
  check('the request stands for the next turn end, and the row carries no refused-park mark', standing?.parkRequestedAt !== undefined && standing.parkRequestedBy === GONE_WINDOW && standing.parkRefused === undefined && sup.pendingParkRequests(dir).includes(w), j({ parkRequestedAt: standing?.parkRequestedAt, parkRefused: standing?.parkRefused }))
  owes.delete(w)
  const late = await idleEdge(w)
  check('when the owed turn has ended the same request parks it', (early || late) && rec(w)?.parkedAt !== undefined, j({ early, late, parkedAt: rec(w)?.parkedAt }))
  killed.length = 0
}

console.log('P3 the operator comes back into the chat: the wish of the window that left is withdrawn')
{
  const w = seedMidTurn('3')
  seat(w)
  quitWhileItWorks(w)
  const focus = sup.focusConcourseSession(sid('3'), THIS_WINDOW, dir)
  check('a focus by a terminal withdraws the request', focus.outcome === 'applied' && rec(w)?.parkRequestedAt === undefined && sup.pendingParkRequests(dir).length === 0, j({ focus, rec: rec(w) }))
  turnEnds(w)
  const parked = await idleEdge(w)
  check('the turn ends under the operator and the session stays: no retirement asked, no kill, not parked', !parked && askedOf(w) === '' && killed.length === 0 && rec(w)?.parkedAt === undefined && rec(w)?.focusedBy === THIS_WINDOW, j({ parked, asked: askedOf(w), killed, parkedAt: rec(w)?.parkedAt }))
  killed.length = 0
}

console.log('P3b the operator comes back while the runner is still answering the retirement: it is called off before the commit')
{
  const w = seedMidTurn('9')
  seat(w)
  quitWhileItWorks(w)
  turnEnds(w)
  held.add(w)
  const edge = idleEdge(w)
  const answerPrepare = await preparing(w)
  const focus = sup.focusConcourseSession(sid('9'), THIS_WINDOW, dir)
  check('the focus lands while prepare is outstanding and withdraws the request', focus.outcome === 'applied' && askedOf(w) === 'prepare' && rec(w)?.parkRequestedAt === undefined, j({ focus, asked: askedOf(w), rec: rec(w) }))
  answerPrepare()
  const parked = await edge
  check('the runner prepared, and the retirement is cancelled instead of committed: not parked, the runner lives, the session is still under the operator', !parked && askedOf(w) === 'prepare,cancel' && killed.length === 0 && rec(w)?.parkedAt === undefined && rec(w)?.parkIntent === undefined && rec(w)?.pid === process.pid && rec(w)?.focusedBy === THIS_WINDOW, j({ parked, asked: askedOf(w), killed, rec: rec(w) }))
  check('nothing is left fenced: the next retirement of this session is asked afresh', !sup.retirementFenced(w))
  held.delete(w)
  killed.length = 0
}

console.log('P3c a stop taken while the runner is still answering the retirement: the row ends stopped, never parked')
{
  const w = seedMidTurn('10')
  seat(w)
  quitWhileItWorks(w)
  turnEnds(w)
  held.add(w)
  const edge = idleEdge(w)
  const answerPrepare = await preparing(w)
  const stop = sup.stopConcourseSession(sid('10'), 'operator', roster, dir)
  check('the stop is taken while prepare is outstanding', stop.outcome === 'applied' && rec(w)?.stopRequestedAt !== undefined, j(stop))
  answerPrepare()
  const parked = await edge
  check('the retirement is cancelled, not committed, and the row is not parked', !parked && askedOf(w) === 'prepare,cancel' && rec(w)?.parkedAt === undefined && rec(w)?.parkIntent === undefined, j({ parked, asked: askedOf(w), rec: rec(w) }))
  runnerLeft(w)
  check('the runner gone, the row reads stopped', sup.completeRequestedStop(w, dir) && rec(w)?.stoppedAt !== undefined && rec(w)?.parkedAt === undefined, j(rec(w)))
  held.delete(w)
  killed.length = 0
}

console.log("P3d the operator's message arrives while the runner is still answering the retirement: it reaches the live session and the retirement is called off; a wake's fire is held for the park as before")
{
  let delivered = 0
  const handler = makeConcourseDispatchHandler({
    admit: async (): Promise<ConcourseAdmitResult> => ({ ok: false, code: 'runtime-ceiling', error: 'this scene admits nothing' }),
    deliver: async () => (delivered++, true),
    dir,
  })
  const spoken = seedMidTurn('12')
  seat(spoken)
  quitWhileItWorks(spoken)
  turnEnds(spoken)
  held.add(spoken)
  const edge = idleEdge(spoken)
  const answerPrepare = await preparing(spoken)
  const said = await handler({ clientMessageId: 'park-lifetime-said-while-preparing', prompt: 'and now this', workspaceDir: '', targetSessionId: sid('12'), by: 'operator' })
  check('the message is delivered at once, not held for a park nobody wants any more, and the request is withdrawn', said.ok === true && said.heldReason === undefined && delivered === 1 && rec(spoken)?.parkRequestedAt === undefined, j({ said, delivered, rec: rec(spoken) }))
  answerPrepare()
  const parked = await edge
  check('the retirement is cancelled instead of committed: not parked, the runner lives', !parked && askedOf(spoken) === 'prepare,cancel' && killed.length === 0 && rec(spoken)?.parkedAt === undefined && rec(spoken)?.parkIntent === undefined && rec(spoken)?.pid === process.pid, j({ parked, asked: askedOf(spoken), rec: rec(spoken) }))
  held.delete(spoken)

  const woken = seedMidTurn('13')
  seat(woken)
  quitWhileItWorks(woken)
  turnEnds(woken)
  held.add(woken)
  const wokenEdge = idleEdge(woken)
  const answerWoken = await preparing(woken)
  const deliveredBefore = delivered
  const wake = await handler({ clientMessageId: 'park-lifetime-wake-while-preparing', prompt: 'a scheduled wake', workspaceDir: '', targetSessionId: sid('13'), by: 'saturn:nightly' })
  check('a fire that is not the operator is held for the park and leaves the request standing', wake.ok === false && wake.heldReason === 'session-retiring' && delivered === deliveredBefore && rec(woken)?.parkRequestedAt !== undefined, j({ wake, delivered, rec: rec(woken) }))
  answerWoken()
  check('…and the session parks', (await wokenEdge) && askedOf(woken) === 'prepare,commit' && rec(woken)?.parkedAt !== undefined, j({ asked: askedOf(woken), rec: rec(woken) }))
  held.delete(woken)
  killed.length = 0
}

console.log('P3e a retirement the runner never took leaves nothing fenced: the door gone, or the runner dead while it prepared, and the next turn end asks afresh')
{
  const doorless = seedMidTurn('14')
  quitWhileItWorks(doorless)
  turnEnds(doorless)
  const early = await idleEdge(doorless)
  check('with no door to the runner the session is not parked, the request stands and the session is not fenced', !early && rec(doorless)?.parkedAt === undefined && rec(doorless)?.parkRequestedAt !== undefined && !sup.retirementFenced(doorless), j({ early, fenced: sup.retirementFenced(doorless), rec: rec(doorless) }))
  seat(doorless)
  const late = await idleEdge(doorless)
  check('the door back, the next edge retires the runner and parks', late && askedOf(doorless) === 'prepare,commit' && rec(doorless)?.parkedAt !== undefined, j({ late, asked: askedOf(doorless), fenced: sup.retirementFenced(doorless) }))

  const died = seedMidTurn('15')
  seat(died)
  quitWhileItWorks(died)
  turnEnds(died)
  dying.add(died)
  const atDeath = await idleEdge(died)
  check('the runner dies while it prepares: not parked by that edge, the request stands, nothing fenced', !atDeath && rec(died)?.parkedAt === undefined && rec(died)?.parkRequestedAt !== undefined && !sup.retirementFenced(died), j({ atDeath, fenced: sup.retirementFenced(died), asked: askedOf(died) }))
  dying.delete(died)
  seat(died)
  let delivered = 0
  const handler = makeConcourseDispatchHandler({
    admit: async (): Promise<ConcourseAdmitResult> => ({ ok: false, code: 'runtime-ceiling', error: 'this scene admits nothing' }),
    deliver: async () => (delivered++, true),
    dir,
  })
  const said = await handler({ clientMessageId: 'park-lifetime-after-death', prompt: 'and now this', workspaceDir: '', targetSessionId: sid('15'), by: 'saturn:nightly' })
  check("a fire for it is delivered to its successor, not held as 'the session is parking'", said.ok === true && said.heldReason === undefined && delivered === 1, j({ said, delivered }))
  turnEnds(died)
  const after = await idleEdge(died)
  check('the successor is asked afresh at its turn end and parks', after && rec(died)?.parkedAt !== undefined && !sup.retirementFenced(died), j({ after, asked: askedOf(died), rec: rec(died) }))
  killed.length = 0
}

console.log('P3f two turn-end edges in one beat ask the runner once; an explicit park that meets the retirement joins it')
{
  const twice = seedMidTurn('16')
  seat(twice)
  quitWhileItWorks(twice)
  turnEnds(twice)
  const both = await Promise.all([idleEdge(twice), idleEdge(twice)])
  check('one prepare, one commit, parked once, nothing fenced', both[0] && both[1] && askedOf(twice) === 'prepare,commit' && rec(twice)?.parkedAt !== undefined && !sup.retirementFenced(twice), j({ both, asked: askedOf(twice), fenced: sup.retirementFenced(twice) }))

  const joined = seedMidTurn('17')
  seat(joined)
  quitWhileItWorks(joined)
  turnEnds(joined)
  held.add(joined)
  const edge = idleEdge(joined)
  const answerPrepare = await preparing(joined)
  const explicit = sup.retireConcourseSession(sid('17'), THIS_WINDOW, roster, dir, { exitWaitMs: 2_000 })
  answerPrepare()
  const [byEdge, byDoor] = await Promise.all([edge, explicit])
  check('the park door answers parked from the retirement already under way: one prepare, one commit, under the name that asked first', byEdge && byDoor.outcome === 'parked' && askedOf(joined) === 'prepare,commit' && rec(joined)?.parkedBy === GONE_WINDOW && rec(joined)?.parkRefused === undefined, j({ byEdge, byDoor, asked: askedOf(joined), rec: rec(joined) }))
  held.delete(joined)
  killed.length = 0
}

console.log('P4 a stop outranks it: the row reads stopped, never parked one rung early')
{
  const w = seedMidTurn('4')
  seat(w)
  quitWhileItWorks(w)
  const stop = sup.stopConcourseSession(sid('4'), 'operator', roster, dir)
  check('the stop is taken (the runner is told to leave)', stop.outcome === 'applied' && killed.join(',') === w && rec(w)?.stopRequestedAt !== undefined, j(stop))
  turnEnds(w)
  const parkedAtStop = await idleEdge(w)
  check("the stopping turn's end parks nothing and asks the runner nothing", !parkedAtStop && askedOf(w) === '' && rec(w)?.parkedAt === undefined, j({ parkedAtStop, asked: askedOf(w), parkedAt: rec(w)?.parkedAt }))
  runnerLeft(w)
  const stopped = sup.completeRequestedStop(w, dir)
  const parkedAfter = await idleEdge(w)
  check('the runner gone, the row is stopped and the old request is gone with it', stopped && !parkedAfter && rec(w)?.stoppedAt !== undefined && rec(w)?.parkedAt === undefined && rec(w)?.parkRequestedAt === undefined, j({ stopped, parkedAfter, rec: rec(w) }))
  killed.length = 0
}

console.log("P5 the operator speaks to it from the board: the request is withdrawn; a wake or a report leaves it standing")
{
  const spoken = seedMidTurn('5')
  const woken = seedMidTurn('6')
  quitWhileItWorks(spoken)
  let delivered = 0
  const handler = makeConcourseDispatchHandler({
    admit: async (): Promise<ConcourseAdmitResult> => ({ ok: false, code: 'runtime-ceiling', error: 'this scene admits nothing' }),
    deliver: async () => (delivered++, true),
    dir,
  })
  const said = await handler({ clientMessageId: 'park-lifetime-said', prompt: 'and now this', workspaceDir: '', targetSessionId: sid('5'), by: 'operator' })
  check("an operator's message is delivered and withdraws the request", said.ok === true && delivered === 1 && rec(spoken)?.parkRequestedAt === undefined, j({ said, rec: rec(spoken) }))
  const wake = await handler({ clientMessageId: 'park-lifetime-wake', prompt: 'a scheduled wake', workspaceDir: '', targetSessionId: sid('6'), by: 'saturn:nightly' })
  check('a delivery that is not the operator leaves the request standing', wake.ok === true && delivered === 2 && rec(woken)?.parkRequestedAt !== undefined && rec(woken)?.parkRequestedBy === GONE_WINDOW, j({ wake, rec: rec(woken) }))
}

console.log("P6 the daemon's own reap keeps nothing back")
{
  const w = seedMidTurn('7')
  seat(w)
  const receipt = sup.parkAllConcourseSessions('daemon:owner-orphaned', roster, dir)
  const focus = sup.focusConcourseSession(sid('7'), THIS_WINDOW, dir)
  check('a focus does not withdraw a request the daemon made on its way out', receipt.draining.includes(w) && focus.outcome === 'applied' && rec(w)?.parkRequestedAt !== undefined && rec(w)?.parkRequestedBy === 'daemon:owner-orphaned', j({ receipt, focus, rec: rec(w) }))
  turnEnds(w)
  const parked = await idleEdge(w)
  check('…and it parks at the turn end', parked && rec(w)?.parkedAt !== undefined && rec(w)?.parkedBy === 'daemon:owner-orphaned', j({ parked, rec: rec(w) }))
}

console.log('P7 a runner that is already gone parks at once')
{
  const w = seedMidTurn('8')
  quitWhileItWorks(w)
  runnerLeft(w)
  killed.length = 0
  check('no retirement to ask for: the record parks under the name that asked, and the roster drops any pending respawn', sup.completeRequestedPark(w, roster, dir) && rec(w)?.parkedAt !== undefined && rec(w)?.parkedBy === GONE_WINDOW && killed.join(',') === w, j({ killed, rec: rec(w) }))
}

close()
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-park-request-lifetime: ALL LAWS HOLD' : `\nprove-park-request-lifetime: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
