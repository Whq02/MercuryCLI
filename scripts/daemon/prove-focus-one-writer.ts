#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

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

const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { retiringRunners } = await import('./retiring-runners.ts')
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


console.log('W2 the state table: the fact moves with every slot-in and leaves with every close')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('a'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w2', sessionId: sid('b'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w3', sessionId: sid('c'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
  ])
  const birth = sup.focusConcourseSession(sid('a'), seat, dir)
  check('birth A ⇒ A is the seat', birth.outcome === 'applied' && focusedBy(seat).join(',') === 'concourse-w1', `outcome ${birth.outcome}, focused by this seat: ${focusedBy(seat).join(',') || 'nobody'} — focusConcourseSession in src/daemon/concourse-workers/focus.ts must stamp the session's record with the seat`)
  const hop = sup.focusConcourseSession(sid('b'), seat, dir)
  check('hop A→B ⇒ B is the seat and A is cleared in the SAME publication', hop.outcome === 'applied' && hop.cleared.join(',') === 'concourse-w1' && focusedBy(seat).join(',') === 'concourse-w2', `outcome ${hop.outcome}, focused by this seat: ${focusedBy(seat).join(',') || 'nobody'} — focusConcourseSession in src/daemon/concourse-workers/focus.ts must move the seat's stamp from A to B in one write`)
  const park = sup.parkConcourseSession(sid('b'), seat, roster, dir)
  check("close B (park) ⇒ nobody's seat (a parked chat is not on screen)", park.outcome === 'applied' && focusedBy(seat).length === 0 && rec('concourse-w2')?.focusedAt === undefined, `outcome ${park.outcome}, focused by this seat: ${focusedBy(seat).join(',') || 'nobody'} — parkConcourseSession in src/daemon/concourse-workers/park.ts must clear the focus stamp of the chat it parks`)
  const reactivate = sup.focusConcourseSession(sid('a'), seat, dir)
  check('reactivate A (the door says focus again) ⇒ A is the seat', reactivate.outcome === 'applied' && focusedBy(seat).join(',') === 'concourse-w1', `outcome ${reactivate.outcome}, focused by this seat: ${focusedBy(seat).join(',') || 'nobody'} — focusConcourseSession in src/daemon/concourse-workers/focus.ts must stamp the seat again after a park`)
  const hopBusy = sup.focusConcourseSession(sid('c'), seat, dir)
  const requested = sup.parkConcourseSession(sid('c'), seat, roster, dir)
  const stampHeld = rec('concourse-w3')?.focusedAt !== undefined && rec('concourse-w3')?.parkRequestedAt !== undefined
  sup.updateConcourseWorkers(ws => { ws['concourse-w3']!.lastTurnSettledAt = now }, dir)
  const retiring = retiringRunners(sup, dir, DEAD_PID)
  retiring.seat('concourse-w3')
  const retired = await sup.retireRequestedPark('concourse-w3', retiring.roster, dir, { exitWaitMs: 2_000 })
  retiring.close()
  check('a park REQUESTED mid-turn keeps the stamp while the chat finishes on screen; the completed park clears it', hopBusy.outcome === 'applied' && requested.outcome === 'draining' && stampHeld && retired && rec('concourse-w3')?.parkedAt !== undefined && rec('concourse-w3')?.focusedAt === undefined, `${JSON.stringify({ hopBusy: hopBusy.outcome, requested: requested.outcome, stampHeld, retired })} — parkConcourseSession answers draining and keeps the focus stamp while the turn runs; retireRequestedPark completes the park and clears it (both in src/daemon/concourse-workers/park.ts)`)
  sup.focusConcourseSession(sid('a'), seat, dir)
  const blur = sup.blurConcourseSession(sid('a'), seat, dir)
  check('blur (the close-all detach) ⇒ cleared', blur.outcome === 'applied' && focusedBy(seat).length === 0, `outcome ${blur.outcome}, focused by this seat: ${focusedBy(seat).join(',') || 'nobody'} — blurConcourseSession in src/daemon/concourse-workers/focus.ts must clear the seat's stamp`)
  const foreign = sup.focusConcourseSession(sid('a'), `operator:${DEAD_PID}`, dir)
  const healed = sup.reconcileConcourseWorkers(new Set(['concourse-w1']), dir)
  check("a dead terminal's stamp heals at the reconcile (the quit's own backstop)", foreign.outcome === 'applied' && healed.live.includes('concourse-w1') && rec('concourse-w1')?.focusedAt === undefined, `${JSON.stringify({ foreign: foreign.outcome, live: healed.live })} — reconcileConcourseWorkers (src/daemon/concourse-workers/concourseWorkers.ts) must clear the focus stamp of a seat whose terminal pid is dead`)
  check('exactly one focused record per terminal at every step (the invariant)', Object.values(sup.readSessionWorkers(dir)).filter(r => r.endedAt === undefined && r.focusedBy === seat).length <= 1, `${focusedBy(seat).join(',')} — more than one live record carries this seat as its focus: the writers in src/daemon/concourse-workers/focus.ts and park.ts must clear the old stamp in the same write that sets a new one`)
}


console.log('W4 newborn × parked (law 5, kept and named)')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('n1'), pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w2', sessionId: sid('n2'), pid: process.pid, bornBlankAt: now - T, lastDeliveryAt: now - T + 1000, lastTurnSettledAt: now - T + 2000 },
  ])
  killed.length = 0
  const newborn = sup.parkConcourseSession(sid('n1'), seat, roster, dir)
  const messaged = sup.parkConcourseSession(sid('n2'), seat, roster, dir)
  check('a chat born and NEVER messaged that the operator closes is RELEASED — killed, ended, never a parked row (nothing to bring back)', newborn.outcome === 'applied' && newborn.released && killed.includes('concourse-w1') && rec('concourse-w1')?.endedAt !== undefined && rec('concourse-w1')?.parkedAt === undefined, `${JSON.stringify({ outcome: newborn.outcome, killed, record: rec('concourse-w1') })} — parkConcourseSession in src/daemon/concourse-workers/park.ts must release (kill and end) a chat with bornBlankAt that was never messaged, not park it`)
  check('a chat born the same way but MESSAGED once is PARKED when closed — on the board, reactivatable', messaged.outcome === 'applied' && !messaged.released && rec('concourse-w2')?.parkedAt !== undefined && rec('concourse-w2')?.endedAt === undefined, `${JSON.stringify({ outcome: messaged.outcome, record: rec('concourse-w2') })} — parkConcourseSession in src/daemon/concourse-workers/park.ts must park, not release, a born-blank chat that has a delivery`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-focus-one-writer: ALL LAWS HOLD' : `\nprove-focus-one-writer: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
