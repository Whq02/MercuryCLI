#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-parked-state.ts — PARKED IS A RECORD STATE (the
//  control-plane model). Pure + file-level over
//  a scratch daemon dir and a scripted roster; no daemon, no child, and the
//  REAL board builder over a scratch home for the row pin.
//
//   L1  THE LADDER AS A TRUTH TABLE: attached × parked × stopped × paused ×
//       crash × needs-you × pid-alive × turn-settled → exactly ONE row state
//       per row. Every parked record reads 'parked' whatever else stands
//       (POISON: a parked record painting as crashed — NEEDS YOU — or as
//       live); every unparked row still reads what the pre-lane ladder read
//       (the arm changed nothing else).
//   L2  THE PARK VERB: an idle runner is killed and the record parks AT
//       ONCE, the operator's other stamps ending with it; a dead runner
//       parks with no kill; a MID-TURN runner is asked ('draining' — the
//       request stamps, nothing is killed) and parks at its own turn-settled
//       edge, a delivery meanwhile deferring it; `afterTurn: false` parks a
//       mid-turn runner now; a re-park is a noop; an unknown session is
//       refused; NEWBORN × PARKED releases (one-door's rule, kept);
//       park-all parks the active estate and leaves the operator's own
//       states alone (stopped, attached, a chat another live terminal holds).
//   L3  THE RECONCILE never re-states a parked record — found dead it is
//       STILL parked (never crashed, never released) — and converges a park
//       request found dead into parked; the dead MESSAGED record beside it
//       still takes the crash fact (the crash-fact law untouched); idempotent.
//   L4  THE REAPER never retires a parked record (the typed 'parked'
//       refusal; the sweep skips it); the poison control — the same empty
//       idle record without the park stamp — IS retired.
//   L5  ADMISSION: a parked record holds no workspace claim — a fresh
//       exclusive session admits into the parked chat's own room even while
//       the roster still lists the killed handle (the /clear road); the
//       control (the same record NOT parked, its runner live) is the
//       collision path.
//   L6  THE BOARD (the real builder): a parked record is ONE parked row in
//       the ONE parked group — the still cell "parked · <age>", the
//       transcript on the row, never doubled by the transcript listing (the
//       same session's file sits in the current project's home), never
//       among the live rows; a park reason paints in the cell instead.
//   L7  THE WIRE + the seams in source: 'park'/'park-all' cross the control
//       server into the daemon handler (park-all before the record lookup,
//       park beside the seat verbs); the idle edge completes a requested
//       park; admission and the pool's seat count exclude parked records;
//       the pickers stop hiding them; the route's double-x releases a
//       parked RECORD; the lifecycle registry names the state.
//
//  POISONS (strike one and watch the FAIL): drop the parked arm from the
//  ladder ⇒ L1/L6 (a parked record reads 'starting' — live); drop the
//  reconcile's parked arm ⇒ L3 (found dead ⇒ crashed); drop the reaper's
//  refusal ⇒ L4; drop `parkedAt === undefined` from admission's live
//  derivation ⇒ L5 (the /clear birth collides); route the record rows past
//  the group merge ⇒ L6 (a doubled or missing row).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'parked-state-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
// The admit door validates the birth's model against SIGNED-IN families
// (the no-credential refusal is the product's honest answer on a blank
// box); this prover's estate is the PARK/ROOM laws, so the fixture key
// stands in — the presence owner reads existence, never validity (the
// prove-unavailable-honesty probe-key idiom).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-parked-state-probe'
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_CONCOURSE_WORKER
delete process.env.MERCURY_SESSION_IDLE_RETIRE_MINUTES
delete process.env.MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES
delete process.env.MERCURY_SESSION_NEWBORN_GRACE_MINUTES
delete process.env.MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

const sup = await import('../../src/daemon/concourseSupervisor.ts')
const idle = await import('../../src/daemon/idleRetirement.ts')
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

const dir = process.env.MERCURY_DAEMON_DIR!
/** A pid no process owns (a dead runner). */
const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()
const sid = (tail: string): string => `00000000-dddd-4000-8000-${tail.padStart(12, '0')}`

function seed(records: Array<Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string }>, workspaceId = SCRATCH): void {
  sup.updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    for (const r of records) {
      workers[r.runnerId] = {
        schema: 1,
        workspaceId,
        isolation: 'exclusive',
        modelKey: 'claude-sonnet-5',
        spawnedAt: now - 3 * T,
        lastLiveAt: now - 3 * T,
        ...r,
      } as ConcourseWorkerRecordV1
    }
  }, dir)
}
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]
const killed: string[] = []
const roster = { kill: (short: string): boolean => (killed.push(short), true) }
const noKill = { kill: (): boolean => false }

// ── L1: the ladder as a truth table ─────────────────────────────────────────
console.log('L1 the state ladder — the truth table')
{
  type Row = { attached: boolean; parked: boolean; stopped: boolean; paused: boolean; crash: boolean; needsYou: boolean; alive: boolean; settled: boolean }
  const bits = [false, true]
  const rows: Row[] = []
  for (const attached of bits) for (const parked of bits) for (const stopped of bits) for (const paused of bits) for (const crash of bits) for (const needsYou of bits) for (const alive of bits) for (const settled of bits) rows.push({ attached, parked, stopped, paused, crash, needsYou, alive, settled })
  // The pre-lane ladder, verbatim (the regression oracle for every unparked row).
  const before = (r: Row): string =>
    r.attached ? 'attached' : r.stopped ? 'stopped' : r.paused ? 'paused' : r.crash ? 'needs-you' : r.needsYou ? 'needs-you' : r.alive ? (r.settled ? 'ready-to-review' : 'working') : 'starting'
  let oneState = 0
  let parkedRight = 0
  let unparkedUnchanged = 0
  const poisons: string[] = []
  for (const r of rows) {
    const record = {
      ...(r.attached ? { attachedAt: now } : {}),
      ...(r.parked ? { parkedAt: now } : {}),
      ...(r.stopped ? { stoppedAt: now } : {}),
      ...(r.paused ? { pausedAt: now } : {}),
      ...(r.crash ? { crash: { at: now, reason: 'crashed', respawning: false } } : {}),
      lastDeliveryAt: now - 1000,
      ...(r.settled ? { lastTurnSettledAt: now } : {}),
    }
    const state = snapshot.concourseRecordState(record, { needsYou: r.needsYou, alive: r.alive })
    if (typeof state === 'string') oneState++
    if (r.parked && !r.attached) {
      if (state === 'parked') parkedRight++
      else poisons.push(`${JSON.stringify(r)} → ${state}`)
    } else if (state === before(r)) unparkedUnchanged++
    else poisons.push(`${JSON.stringify(r)} → ${state} (was ${before(r)})`)
  }
  const parkedRows = rows.filter(r => r.parked && !r.attached).length
  check(`every one of the ${rows.length} rows yields exactly one state`, oneState === rows.length)
  check(`every parked row (${parkedRows}) reads 'parked' — whatever its pid, crash fact, stop, pause or turn stamps say`, parkedRight === parkedRows, poisons.slice(0, 3).join(' | '))
  check(`every unparked row (${rows.length - parkedRows}) reads what the pre-lane ladder read (the arm changed nothing else)`, unparkedUnchanged === rows.length - parkedRows, poisons.slice(0, 3).join(' | '))
  check("POISON: no parked record ever paints NEEDS YOU or a live state", !rows.some(r => r.parked && !r.attached && ['needs-you', 'working', 'ready-to-review', 'starting'].includes(snapshot.concourseRecordState({ parkedAt: now, ...(r.crash ? { crash: { at: now, reason: 'x', respawning: false } } : {}) }, { needsYou: r.needsYou, alive: r.alive }))))
  check("attached outranks parked (the one-terminal swap is the operator's own terminal)", snapshot.concourseRecordState({ attachedAt: now, parkedAt: now }, { needsYou: false, alive: false }) === 'attached')
}

// ── L2: the park verb ───────────────────────────────────────────────────────
console.log('L2 the park verb')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('1'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5, crash: { at: now - T, reason: 'crashed mid-run', respawning: false }, pausedAt: now - T, pausedBy: 'operator', focusedAt: now - T, focusedBy: `operator:${process.pid}` },
    { runnerId: 'concourse-w2', sessionId: sid('2'), pid: DEAD_PID, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w3', sessionId: sid('3'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
    { runnerId: 'concourse-w4', sessionId: sid('4'), pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w5', sessionId: sid('5'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
    { runnerId: 'concourse-w6', sessionId: sid('6'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
  ])
  killed.length = 0
  const idleOut = sup.parkConcourseSession(sid('1'), 'operator:test', roster, dir)
  const w1 = rec('concourse-w1')
  check('an idle live runner: killed, the record parks at once', idleOut.outcome === 'applied' && !idleOut.released && killed.includes('concourse-w1') && w1?.parkedAt !== undefined && w1.parkedBy === 'operator:test' && w1.endedAt === undefined, JSON.stringify(idleOut))
  check("the operator's other stamps end with the close: crash, pause, focus cleared; the record stays un-ended", w1?.crash === undefined && w1?.pausedAt === undefined && w1?.focusedAt === undefined && w1?.focusedBy === undefined)
  check('the sibling record is untouched by the publication', rec('concourse-w6')?.parkedAt === undefined && rec('concourse-w6')?.pid === process.pid)
  check('a re-park is a noop', sup.parkConcourseSession(sid('1'), 'operator:test', roster, dir).outcome === 'noop')
  check('an unknown session is refused typed', sup.parkConcourseSession(sid('99'), 'operator:test', roster, dir).outcome === 'refused')
  killed.length = 0
  const deadOut = sup.parkConcourseSession(sid('2'), 'operator:test', roster, dir)
  check('a dead runner parks with no kill (nothing to kill)', deadOut.outcome === 'applied' && killed.length === 0 && rec('concourse-w2')?.parkedAt !== undefined)
  const busyOut = sup.parkConcourseSession(sid('3'), 'operator:test', roster, dir)
  const w3 = rec('concourse-w3')
  check("a MID-TURN runner is asked, not killed: 'draining', the request stamped, no parkedAt", busyOut.outcome === 'draining' && !killed.includes('concourse-w3') && w3?.parkRequestedAt !== undefined && w3.parkRequestedBy === 'operator:test' && w3.parkedAt === undefined, JSON.stringify(busyOut))
  check('the pending set names it', sup.pendingParkRequests(dir).join(',') === 'concourse-w3')
  check('the idle edge before the turn settles completes nothing', sup.completeRequestedPark('concourse-w3', roster, dir) === false && rec('concourse-w3')?.parkedAt === undefined)
  sup.updateConcourseWorkers(ws => { ws['concourse-w3']!.lastTurnSettledAt = now }, dir)
  check('the turn-settled edge completes the park: killed, parked, the request cleared', sup.completeRequestedPark('concourse-w3', roster, dir) === true && killed.includes('concourse-w3') && rec('concourse-w3')?.parkedAt !== undefined && rec('concourse-w3')?.parkRequestedAt === undefined && rec('concourse-w3')?.parkedBy === 'operator:test')
  check('a second edge is quiet', sup.completeRequestedPark('concourse-w3', roster, dir) === false && sup.pendingParkRequests(dir).length === 0)
  killed.length = 0
  const nowOut = sup.parkConcourseSession(sid('5'), 'operator:test', roster, dir, { afterTurn: false })
  check('afterTurn: false parks a mid-turn runner now (the drain ceiling road)', nowOut.outcome === 'applied' && killed.includes('concourse-w5') && rec('concourse-w5')?.parkedAt !== undefined)
  killed.length = 0
  const newbornOut = sup.parkConcourseSession(sid('4'), 'operator:test', roster, dir)
  check('NEWBORN × PARKED: a chat born and never messaged is RELEASED, not parked (killed, endedAt set, no parkedAt)', newbornOut.outcome === 'applied' && newbornOut.released && killed.includes('concourse-w4') && rec('concourse-w4')?.endedAt !== undefined && rec('concourse-w4')?.parkedAt === undefined, JSON.stringify(newbornOut))
  const reasoned = sup.parkConcourseSession(sid('6'), 'daemon:test', roster, dir, { reason: 'parked — the runner refused to come back' })
  check('a reason rides the park (the failed-reactivate row line)', reasoned.outcome === 'applied' && rec('concourse-w6')?.parkReason === 'parked — the runner refused to come back')
  // The reseed keeps a PARKED w1 beside the live w7: the stop-noop leg below
  // reads w1 (a seed that carried only w7 made it 'unknown-session').
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('1'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5, parkedAt: now, parkedBy: 'operator:test' },
    { runnerId: 'concourse-w7', sessionId: sid('7'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
  ])
  const refused = sup.parkConcourseSession(sid('7'), 'operator:test', noKill, dir)
  check("a live child the kill does not reach is refused 'no-kill-channel' and the record stays live (parkedAt's contract)", refused.outcome === 'refused' && refused.reason === 'no-kill-channel' && rec('concourse-w7')?.parkedAt === undefined)
  const stopped = sup.stopConcourseSession(sid('1'), 'operator', roster, dir)
  check('a stop on a parked record is a noop (never a second state over parked)', stopped.outcome === 'noop' && rec('concourse-w1')?.stoppedAt === undefined && rec('concourse-w1')?.parkedAt !== undefined, JSON.stringify({ stopped, stoppedAt: rec('concourse-w1')?.stoppedAt, parkedAt: rec('concourse-w1')?.parkedAt }))
}

console.log('L2b park-all — the quit path over the estate')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('a1'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w2', sessionId: sid('a2'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
    { runnerId: 'concourse-w3', sessionId: sid('a3'), pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w4', sessionId: sid('a4'), pid: DEAD_PID, stoppedAt: now - T, stoppedBy: 'operator' },
    { runnerId: 'concourse-w5', sessionId: sid('a5'), pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test' },
    { runnerId: 'concourse-w6', sessionId: sid('a6'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5, focusedAt: now, focusedBy: `operator:${process.pid}` },
    { runnerId: 'concourse-w7', sessionId: sid('a7'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5, focusedAt: now, focusedBy: `operator:${DEAD_PID}` },
  ])
  killed.length = 0
  const all = sup.parkAllConcourseSessions('operator:1', roster, dir, { exceptFocusedByLiveTerminal: true })
  check("the screen's quit: idle sessions park at once (a chat focused by a DEAD terminal too)", all.parked.sort().join(',') === 'concourse-w1,concourse-w7', JSON.stringify(all))
  check('a mid-turn session drains (parks after its own turn)', all.draining.join(',') === 'concourse-w2' && rec('concourse-w2')?.parkRequestedAt !== undefined)
  check('a newborn is released', all.released.join(',') === 'concourse-w3' && rec('concourse-w3')?.endedAt !== undefined)
  check("the operator's own stop and a chat ANOTHER LIVE terminal holds are left alone", all.skipped.sort().join(',') === 'concourse-w4,concourse-w6' && rec('concourse-w4')?.stoppedAt !== undefined && rec('concourse-w6')?.parkedAt === undefined)
  check('an already-parked record is neither re-parked nor listed', !all.parked.includes('concourse-w5') && !all.skipped.includes('concourse-w5'))
  const teardown = sup.parkAllConcourseSessions('daemon:owner-orphaned', roster, dir)
  check("the owned daemon's teardown parks everything active — the other terminal's chat included (the daemon is going down)", teardown.parked.join(',') === 'concourse-w6' && rec('concourse-w6')?.parkedAt !== undefined)
}

// ── L3: the reconcile ───────────────────────────────────────────────────────
console.log('L3 the reconcile never re-states a parked record')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('r1'), pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test', lastDeliveryAt: now - 2 * T, lastTurnSettledAt: now - 2 * T + 5 },
    { runnerId: 'concourse-w2', sessionId: sid('r2'), pid: DEAD_PID, parkRequestedAt: now - T, parkRequestedBy: 'operator:test', lastDeliveryAt: now - 2 * T },
    { runnerId: 'concourse-w3', sessionId: sid('r3'), pid: DEAD_PID, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
  ])
  const receipt = sup.reconcileConcourseWorkers(new Set(), dir)
  check('a parked record found dead is STILL parked — no crash fact, no endedAt (never crashed, never released)', receipt.parked.includes('concourse-w1') && rec('concourse-w1')?.parkedAt !== undefined && rec('concourse-w1')?.crash === undefined && rec('concourse-w1')?.endedAt === undefined, JSON.stringify(receipt))
  check('a park REQUEST found dead converges to parked (the operator closed it; nothing about that is a crash)', receipt.parked.includes('concourse-w2') && rec('concourse-w2')?.parkedAt !== undefined && rec('concourse-w2')?.parkRequestedAt === undefined && rec('concourse-w2')?.crash === undefined)
  check("the dead MESSAGED record beside them still takes the crash fact (the crash-fact law untouched)", receipt.settled.includes('concourse-w3') && rec('concourse-w3')?.crash !== undefined && rec('concourse-w3')?.endedAt === undefined)
  const again = sup.reconcileConcourseWorkers(new Set(), dir)
  check('the re-run is idempotent (nothing settles or converts twice)', again.settled.length === 0 && rec('concourse-w1')?.crash === undefined && rec('concourse-w2')?.crash === undefined)
}

// ── L4: the reaper ──────────────────────────────────────────────────────────
console.log('L4 the idle reaper never retires a parked record')
{
  const facts = { alive: true, hasConversation: false, hasPendingWork: false, nowMs: now, thresholdMs: T }
  const parkedDecision = idle.decideIdleRetirement({ rec: { spawnedAt: now - 3 * T, parkedAt: now - T }, ...facts })
  check("the pure decision refuses 'parked' (after 'ended', before 'stopped')", !parkedDecision.retire && parkedDecision.reason === 'parked')
  const retiredDecision = idle.decideIdleRetirement({ rec: { spawnedAt: now - 3 * T }, ...facts })
  check('POISON CONTROL: the same facts without the park stamp retire', retiredDecision.retire)
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('i1'), pid: process.pid, parkedAt: now - T, parkedBy: 'operator:test' },
    { runnerId: 'concourse-w2', sessionId: sid('i2'), pid: process.pid },
  ])
  killed.length = 0
  const swept = idle.sweepIdleEmptyConcourseSessions(roster, { dir, nowMs: now, thresholdMs: T })
  check('the sweep skips the parked record (parked with no runner is still parked)', !swept.some(r => r.runnerId === 'concourse-w1') && rec('concourse-w1')?.parkedAt !== undefined && rec('concourse-w1')?.stoppedAt === undefined)
  check('POISON CONTROL: the unparked empty idle twin IS retired', swept.some(r => r.runnerId === 'concourse-w2') && rec('concourse-w2')?.stoppedAt !== undefined)
}

// ── L5: admission — a parked record holds no workspace claim ────────────────
console.log('L5 admission: a parked chat holds no room')
{
  const room = mkdtempSync(join(tmpdir(), 'parked-room-'))
  const registered: string[] = []
  const present = new Set<string>()
  const fakeRoster = {
    list: () => [...present].map(short => ({ short })),
    has: (short: string) => ({ present: present.has(short), alive: present.has(short), ready: true }),
    registerLongLived: (short: string) => {
      registered.push(short)
      present.add(short)
      return { ok: true, pid: process.pid }
    },
    kill: (short: string) => present.delete(short),
  }
  const admit = sup.makeConcourseAdmitHandler({ roster: () => fakeRoster as never, dir })
  // The killed handle lingers on the roster for a moment after the park
  // (the R7 C-LOW-1 class) — the exact window /clear's birth lands in.
  present.add('concourse-w1')
  seed([{ runnerId: 'concourse-w1', sessionId: sid('m1'), pid: DEAD_PID, parkedAt: now - 1000, parkedBy: 'operator:test', lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 }], sup.canonicalWorkspaceId(room))
  const born = await admit({ workspaceDir: room, bornBlank: true })
  check('a fresh exclusive session admits into the parked chat\'s room (no collision, no worktree, no git offer)', born.ok && sup.readSessionWorkers(dir)[born.runnerId]?.isolation === 'exclusive', JSON.stringify(born))
  check('the parked record keeps its own short; the birth mints another (never a recycled id)', born.ok && born.runnerId !== 'concourse-w1' && rec('concourse-w1')?.parkedAt !== undefined)
  // The control: the same record NOT parked with a live runner holds the room.
  present.clear()
  present.add('concourse-w1')
  seed([{ runnerId: 'concourse-w1', sessionId: sid('m1'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 }], sup.canonicalWorkspaceId(room))
  const collided = await admit({ workspaceDir: room, bornBlank: true })
  check('POISON CONTROL: the unparked live twin holds the room (the plain-folder collision answers the git offer)', !collided.ok && collided.code === 'no-repository', JSON.stringify(collided))
  rmSync(room, { recursive: true, force: true })
}

// ── L6: the board over the real builder ─────────────────────────────────────
console.log('L6 the board: one parked row, one parked group')
{
  const project = getCwd()
  const workspaceId = sup.canonicalWorkspaceId(project)
  const crewDir = join(SCRATCH, 'crew')
  const draftDir = join(SCRATCH, 'draft')
  for (const d of [crewDir, draftDir]) mkdirSync(d, { recursive: true })
  const parkedSid = sid('b1')
  const liveSid = sid('b2')
  const reasonSid = sid('b3')
  // The parked session's own transcript sits where the transcript listing
  // looks (the current project's home) — the row must still paint ONCE.
  const file = workerTranscriptPath({ sessionId: parkedSid, workspaceId: project })
  mkdirSync(dirname(file), { recursive: true })
  const userRow = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: project, sessionId: parkedSid, version: '1.0.0-beta.1', gitBranch: 'main', parentUuid: null, uuid: '00000000-0000-4000-8000-00000000b001', timestamp: new Date(now).toISOString(), type: 'user', message: { role: 'user', content: 'park me please' } }
  writeFileSync(file, encodeSeedTranscript([userRow] as never, parkedSid))
  seed(
    [
      { runnerId: 'concourse-w1', sessionId: parkedSid, pid: DEAD_PID, parkedAt: now - 2 * T, parkedBy: 'operator:test', title: 'the parked chat', lastDeliveryAt: now - 3 * T, lastTurnSettledAt: now - 3 * T + 5 },
      { runnerId: 'concourse-w2', sessionId: liveSid, pid: process.pid, title: 'the live chat', lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
      { runnerId: 'concourse-w3', sessionId: reasonSid, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'daemon:test', parkReason: 'parked — the runner refused to come back', title: 'the refused chat' },
    ],
    workspaceId,
  )
  const snap = await snapshot.buildConcourseSnapshot({ recordsDir: dir, crewDir, draftDir, nowMs: now })
  const flat = snap.groups.flatMap(g => g.rows)
  const parkedGroup = snap.groups.find(g => g.id === 'parked')
  const parkedRow = parkedGroup?.rows.find(r => r.sessionId === parkedSid)
  check('the parked record is a parked row in the PARKED group', parkedRow !== undefined && parkedRow.state === 'parked', JSON.stringify(snap.groups.map(g => [g.id, g.rows.map(r => r.sessionId.slice(-2))])))
  check('exactly ONE row carries the session (never doubled by the transcript listing)', flat.filter(r => r.sessionId === parkedSid).length === 1)
  check('ONE parked group, the LAST group', snap.groups.filter(g => g.id === 'parked').length === 1 && snap.groups[snap.groups.length - 1]?.id === 'parked')
  check('the cell is still: "parked · <age since the close>" — no motion, no tail read', parkedRow?.nowLabel === `parked · ${snapshot.ageLabelOf(now, now - 2 * T)}`, String(parkedRow?.nowLabel))
  check('the transcript rides the row for the resume door; the title is the record\'s', parkedRow?.transcriptPath === file && parkedRow?.title === 'the parked chat')
  check('newest close first among parked records; a park reason paints in the cell', parkedGroup?.rows[0]?.sessionId === reasonSid && parkedGroup?.rows[0]?.nowLabel === 'parked — the runner refused to come back')
  check('the live record keeps its live row; counts.live counts it alone', snap.groups.some(g => g.id !== 'parked' && g.rows.some(r => r.sessionId === liveSid)) && snap.counts.live === 1)
  check('the peek never lands on a parked record', snap.peek?.sessionId === liveSid)
  check('the pickers no longer hide a parked record (resumable history), still hide the live one', !sup.boardHomedSessionIds(dir).has(parkedSid) && sup.boardHomedSessionIds(dir).has(liveSid))
}

// ── L7: the wire + the seams in source ──────────────────────────────────────
console.log('L7 the wire and the seams')
{
  const protocol = read('src/daemon/protocol.ts')
  const controlAt = protocol.indexOf("op: 'sessionControl'")
  const controlBody = protocol.slice(controlAt, protocol.indexOf('sessionId: string', controlAt))
  check("the protocol names 'park' and 'park-all' on sessionControl", controlBody.includes("| 'park'") && controlBody.includes("| 'park-all'"))
  const server = read('src/daemon/controlServer.ts')
  check('the control server admits both verbs', server.includes("raw.action === 'park' ||") && server.includes("raw.action === 'park-all'") && server.includes('focus|blur|park|park-all'))
  const main = read('src/daemon/main.ts')
  const handlerAt = main.indexOf('concourseControl: ({ action, sessionId, by')
  const lookupAt = main.indexOf('const rec = Object.values(readSessionWorkers()).find(', handlerAt)
  const parkAllAt = main.indexOf("if (action === 'park-all') {", handlerAt)
  const parkAt = main.indexOf("if (action === 'park') {", handlerAt)
  const seatVerbsAt = main.indexOf("if (action === 'set-model') {", handlerAt)
  check('the daemon handler: park-all before the record lookup (no session named), park after it and before the seat verbs', parkAllAt !== -1 && parkAllAt < lookupAt && lookupAt < parkAt && parkAt < seatVerbsAt)
  check('park-all rides parkAllConcourseSessions with the live-terminal exception; park rides parkConcourseSession', main.slice(parkAllAt, lookupAt).includes('exceptFocusedByLiveTerminal: true') && main.slice(parkAt, seatVerbsAt).includes('parkConcourseSession(sessionId, by, roster ?? undefined)'))
  const idleAt = main.indexOf('onIdle: short => {')
  check("the roster's idle edge completes a requested park (a mid-turn close finishes its turn, then parks)", main.slice(idleAt, idleAt + 800).includes('completeRequestedPark(short, roster)'))
  const supervisor = read('src/daemon/concourseSupervisor.ts')
  check("admission's live-worker derivation excludes parked records", supervisor.includes('r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined)'))
  check("the pool's seat count excludes them the same way", read('src/daemon/warmRunner.ts').includes('r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined)'))
  const reconcileAt = supervisor.indexOf('export function reconcileConcourseWorkers(')
  const reconcileBody = supervisor.slice(reconcileAt, supervisor.indexOf('export function listConcourseWorkers(', reconcileAt))
  check('the reconcile answers parked before the crash arm (and never releases it)', reconcileBody.indexOf('if (rec.parkedAt !== undefined) {') !== -1 && reconcileBody.indexOf('if (rec.parkedAt !== undefined) {') < reconcileBody.indexOf('rec.crash = {'))
  check('the pickers read parked records as resumable history', supervisor.includes('if (rec.endedAt === undefined && rec.parkedAt === undefined) out.add(rec.sessionId)'))
  check("the reaper's typed refusal", read('src/daemon/idleRetirement.ts').includes("if (rec.parkedAt !== undefined) return { retire: false, reason: 'parked' }"))
  const board = read('src/services/concourse/concourseSnapshot.ts')
  check("the ladder reads parkedAt right after attachedAt", /rec\.attachedAt !== undefined\s*\?\s*'attached'\s*:\s*rec\.parkedAt !== undefined\s*\?\s*'parked'/.test(board))
  check('the builder merges the record rows and the transcript rows into ONE parked group, records first', board.includes('const parkedRows = [...parkedRecordRows, ...parkedTranscriptRows]') && board.includes('rows.push(...parkedTranscriptRows)'))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const removeAt = route.indexOf('removeSession: sessionId => {')
  const removeBody = route.slice(removeAt, route.indexOf('openObligation: obligationId => {', removeAt))
  check("the route's double-x on a parked RECORD falls through to the release door (a record-less parked row still ends at the cleared mark)", removeBody.indexOf('parkedRecord === undefined') !== -1 && removeBody.indexOf('parkedRecord === undefined') < removeBody.indexOf("op: 'sessionRelease'"))
  check('the lifecycle registry names the parked state on the records row', /parkedAt set \(the operator CLOSED the chat/.test(read('src/substrate/stateLifecycle.ts')))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-parked-state: ALL LAWS HOLD' : `\nprove-parked-state: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
