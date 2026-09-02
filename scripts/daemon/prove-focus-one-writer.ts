#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-focus-one-writer.ts — THE FOCUS FACT MOVES WITH EVERY
//  SLOT-IN (law 4 of the reactivation lifecycle) and NEWBORN × PARKED (law 5).
//  Pure + file-level over a scratch records
//  dir; no daemon, no child.
//
//   W1  ONE WRITER, by grep: every assignment of focusedAt/focusedBy in src
//       lives in focusConcourseSession (the record functions that END the
//       fact — settle, park — only delete it); every call of the terminal's
//       seat verb lives in daemonConnector.ts (attach → focus, detach →
//       blur, the send re-assert, the reactivate's assertSeat) on the one
//       serialized chain; the daemon's 'focus'/'blur' handler is the wire's
//       one door to the writer.
//   W2  THE STATE TABLE (executed over the real verbs, this prover's pid as
//       the live terminal): birth A ⇒ A focused; hop A→B ⇒ B focused, A
//       cleared in the same publication; park B ⇒ nobody's seat; reactivate
//       A (the door says focus again) ⇒ A focused; blur ⇒ cleared; a dead
//       terminal's stamp heals at the reconcile; a park request keeps the
//       stamp (the chat is still on screen while its turn finishes).
//   W3  EVERY SLOT-IN ROAD stamps THROUGH the connector's attach (source):
//       the birth door hops; the hop attaches; the resume door attaches and
//       re-says the seat once the record stands; Projects-↵ and the board's
//       ↵ ride those doors; every close road rests the slot, whose detach
//       says the blur — no road writes the fact by hand.
//   W4  NEWBORN × PARKED (law 5, one-door's rule kept): a chat born and
//       never messaged that the operator closes is RELEASED, not parked; a
//       messaged chat closed is PARKED — the pair pinned side by side.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'focus-one-writer-'))
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
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
/** `grep -rn` over src for a pattern — the one-writer census. */
function grepSrc(pattern: string): string[] {
  try {
    return execFileSync('grep', ['-rn', '-E', pattern, 'src'], { encoding: 'utf8', cwd: process.cwd() }).split('\n').filter(l => l.trim() !== '')
  } catch {
    return []
  }
}

const sup = await import('../../src/daemon/concourseSupervisor.ts')
const dir = process.env.MERCURY_DAEMON_DIR!
const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()
const sid = (tail: string): string => `00000000-ffff-4000-8000-${tail.padStart(12, '0')}`
const seat = `operator:${process.pid}`
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]
const focusedBy = (by: string): string[] => Object.values(sup.readSessionWorkers(dir)).filter(r => r.endedAt === undefined && r.focusedBy === by).map(r => r.runnerId)

function seed(records: Array<Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string }>): void {
  sup.updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    for (const r of records) {
      workers[r.runnerId] = {
        schema: 1,
        workspaceId: SCRATCH,
        isolation: 'exclusive',
        modelKey: 'claude-sonnet-5',
        spawnedAt: now - 3 * T,
        lastLiveAt: now - 3 * T,
        ...r,
      } as ConcourseWorkerRecordV1
    }
  }, dir)
}
const killed: string[] = []
const roster = { kill: (short: string): boolean => (killed.push(short), true) }

// ── W1: one writer, by grep ─────────────────────────────────────────────────
console.log('W1 the focus fact has ONE writer')
{
  const assignments = grepSrc('\\.focusedAt = |\\.focusedBy = |focusedAt: Date|focusedBy: ')
  const foreign = assignments.filter(l => !l.startsWith('src/daemon/concourseSupervisor.ts'))
  check('every focusedAt/focusedBy assignment in src lives in concourseSupervisor.ts', assignments.length > 0 && foreign.length === 0, foreign.join(' | '))
  const supervisor = read('src/daemon/concourseSupervisor.ts')
  const writerAt = supervisor.indexOf('export function focusConcourseSession(')
  const writerBody = supervisor.slice(writerAt, supervisor.indexOf('export function blurConcourseSession(', writerAt))
  const stampSites = (supervisor.match(/rec\.focusedAt = Date\.now\(\)/g) ?? []).length
  check('the ONE stamp site is focusConcourseSession (settle and park only DELETE the fact)', stampSites === 1 && writerBody.includes('rec.focusedAt = Date.now()') && supervisor.includes('delete rec.focusedAt') )
  const verbSites = grepSrc("seatVerb\\('(focus|blur)'")
  const verbForeign = verbSites.filter(l => !l.startsWith('src/services/engine-connector/daemonConnector.ts'))
  check("every seat-verb call site lives in daemonConnector.ts (attach → focus, detach → blur, the send re-assert, assertSeat) on the one chain", verbSites.length >= 4 && verbForeign.length === 0, verbForeign.join(' | '))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the chain is module-level and serialized (a late blur never lands over a re-focus)', connector.includes('let seatChain: Promise<unknown> = Promise.resolve()') && connector.includes('seatChain = seatChain'))
  const wireCallers = grepSrc('focusConcourseSession\\(|blurConcourseSession\\(').filter(l => !l.startsWith('src/daemon/concourseSupervisor.ts'))
  check("the daemon's focus/blur handler (main.ts) is the wire's only door to the writer", wireCallers.length > 0 && wireCallers.every(l => l.startsWith('src/daemon/main.ts')), wireCallers.join(' | '))
}

// ── W2: the state table ─────────────────────────────────────────────────────
console.log('W2 the state table: the fact moves with every slot-in and leaves with every close')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('a'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w2', sessionId: sid('b'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w3', sessionId: sid('c'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
  ])
  const birth = sup.focusConcourseSession(sid('a'), seat, dir)
  check('birth A ⇒ A is the seat', birth.outcome === 'applied' && focusedBy(seat).join(',') === 'concourse-w1')
  const hop = sup.focusConcourseSession(sid('b'), seat, dir)
  check('hop A→B ⇒ B is the seat and A is cleared in the SAME publication', hop.outcome === 'applied' && hop.cleared.join(',') === 'concourse-w1' && focusedBy(seat).join(',') === 'concourse-w2')
  const park = sup.parkConcourseSession(sid('b'), seat, roster, dir)
  check("close B (park) ⇒ nobody's seat (a parked chat is not on screen)", park.outcome === 'applied' && focusedBy(seat).length === 0 && rec('concourse-w2')?.focusedAt === undefined)
  const reactivate = sup.focusConcourseSession(sid('a'), seat, dir)
  check('reactivate A (the door says focus again) ⇒ A is the seat', reactivate.outcome === 'applied' && focusedBy(seat).join(',') === 'concourse-w1')
  const hopBusy = sup.focusConcourseSession(sid('c'), seat, dir)
  const requested = sup.parkConcourseSession(sid('c'), seat, roster, dir)
  check('a park REQUESTED mid-turn keeps the stamp while the chat finishes on screen; the completed park clears it', hopBusy.outcome === 'applied' && requested.outcome === 'draining' && rec('concourse-w3')?.focusedAt !== undefined && (sup.updateConcourseWorkers(ws => { ws['concourse-w3']!.lastTurnSettledAt = now }, dir), sup.completeRequestedPark('concourse-w3', roster, dir)) && rec('concourse-w3')?.focusedAt === undefined)
  sup.focusConcourseSession(sid('a'), seat, dir)
  const blur = sup.blurConcourseSession(sid('a'), seat, dir)
  check('blur (the close-all detach) ⇒ cleared', blur.outcome === 'applied' && focusedBy(seat).length === 0)
  const foreign = sup.focusConcourseSession(sid('a'), `operator:${DEAD_PID}`, dir)
  const healed = sup.reconcileConcourseWorkers(new Set(['concourse-w1']), dir)
  check("a dead terminal's stamp heals at the reconcile (the quit's own backstop)", foreign.outcome === 'applied' && healed.live.includes('concourse-w1') && rec('concourse-w1')?.focusedAt === undefined)
  check('exactly one focused record per terminal at every step (the invariant)', Object.values(sup.readSessionWorkers(dir)).filter(r => r.endedAt === undefined && r.focusedBy === seat).length <= 1)
}

// ── W3: every slot-in road stamps through the connector's attach ────────────
console.log('W3 every slot-in road rides the connector (source)')
{
  const birth = read('src/services/switchboard/bornSession.ts')
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the birth door hops (bornSession → hopIntoBoardSession) — it never stamps by hand', birth.includes('hopIntoBoardSession(sessionId') && !birth.includes('focusConcourseSession') && !birth.includes("action: 'focus'"))
  check('the hop attaches the connector (focusDaemonSession → attach → the focus verb)', hop.includes('seat.focusDaemonSession({') && connector.includes("seatVerb('focus', this.record.sessionId)\n    return this.tick()"))
  check('the resume door attaches first and re-says the seat once the record stands', hop.includes('seat.focusDaemonSession(connector.record)') && hop.includes('connector.assertSeat()'))
  check('Projects-↵ and the board\'s ↵ ride those doors (the face and the route)', read('src/components/BootSplashScreen.tsx').includes('focusResumedSession(p.sessionId, p.transcriptPath') && read('src/components/concourse/ConcourseRoute.tsx').includes('hops.focusResumedSession(sessionId, parked.transcriptPath, { title: parked.title })') && read('src/components/concourse/ConcourseRoute.tsx').includes('hops.hopIntoBoardSession(sessionId)'))
  check('every close road rests the slot, whose detach says the blur (the subscribe hook detaches the connector that lost the slot)', hop.includes('slot.releaseFocusedSessionConnector()') && read('src/components/concourse/ConcourseRoute.tsx').includes('if (!repointed) slot.releaseFocusedSessionConnector()') && connector.includes("if (c !== focused && c.isAttached()) c.detach()") && connector.includes("seatVerb('blur', this.record.sessionId)"))
  const roads = grepSrc("action: 'focus'|action: 'blur'").filter(l => !l.startsWith('src/services/engine-connector/daemonConnector.ts') && !l.startsWith('src/daemon/'))
  check('no screen road sends the verbs by hand (the connector is the only sender)', roads.length === 0, roads.join(' | '))
}

// ── W4: newborn × parked ────────────────────────────────────────────────────
console.log('W4 newborn × parked (law 5, kept and named)')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('n1'), pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w2', sessionId: sid('n2'), pid: process.pid, bornBlankAt: now - T, lastDeliveryAt: now - T + 1000, lastTurnSettledAt: now - T + 2000 },
  ])
  killed.length = 0
  const newborn = sup.parkConcourseSession(sid('n1'), seat, roster, dir)
  const messaged = sup.parkConcourseSession(sid('n2'), seat, roster, dir)
  check('a chat born and NEVER messaged that the operator closes is RELEASED — killed, ended, never a parked row (nothing to bring back)', newborn.outcome === 'applied' && newborn.released && killed.includes('concourse-w1') && rec('concourse-w1')?.endedAt !== undefined && rec('concourse-w1')?.parkedAt === undefined)
  check('a chat born the same way but MESSAGED once is PARKED when closed — on the board, reactivatable', messaged.outcome === 'applied' && !messaged.released && rec('concourse-w2')?.parkedAt !== undefined && rec('concourse-w2')?.endedAt === undefined)
  check("the one definition (isNewbornRecord) is what the park verb, the reaper's grace and the reconcile's release all read", read('src/daemon/concourseSupervisor.ts').split('isNewbornRecord(').length >= 3 && read('src/daemon/idleRetirement.ts').includes('rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-focus-one-writer: ALL LAWS HOLD' : `\nprove-focus-one-writer: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
