#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'close-all-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const idle = await import('../../src/daemon/control/idleRetirement.ts')
const handover = await import('../../src/platform/substrate/splashHandover.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
const { retiringRunners } = await import('./retiring-runners.ts')
const dir = process.env.MERCURY_DAEMON_DIR!
const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`

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
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]
const killed: string[] = []
const roster = { kill: (short: string): boolean => (killed.push(short), true) }

console.log('Q1 the quit story: the screen dies, the estate parks, the next boot finds it parked')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('1'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5, focusedAt: now, focusedBy: `operator:${process.pid}` },
    { runnerId: 'concourse-w2', sessionId: sid('2'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
    { runnerId: 'concourse-w3', sessionId: sid('3'), pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w4', sessionId: sid('4'), pid: DEAD_PID, stoppedAt: now - T, stoppedBy: 'operator' },
    { runnerId: 'concourse-w5', sessionId: sid('5'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
  ])
  killed.length = 0
  const receipt = sup.parkAllConcourseSessions('daemon:owner-orphaned', roster, dir)
  check('idle ⇒ parked at once (killed; the focus stamp of the dead screen ends with the close)', receipt.parked.includes('concourse-w1') && killed.includes('concourse-w1') && rec('concourse-w1')?.parkedAt !== undefined && rec('concourse-w1')?.focusedAt === undefined, 'fix parkAllConcourseSessions in src/daemon/concourse-workers/concourseWorkers.ts so an idle runner is killed and parked and its focus stamp cleared')
  check('mid-turn ⇒ a park request, NO kill (the runner finishes its own turn)', receipt.draining.sort().join(',') === 'concourse-w2,concourse-w5' && !killed.includes('concourse-w2') && !killed.includes('concourse-w5') && rec('concourse-w2')?.parkRequestedAt !== undefined && rec('concourse-w2')?.parkedAt === undefined, `fix parkAllConcourseSessions in src/daemon/concourse-workers/concourseWorkers.ts so a mid-turn runner gets a park request and no kill; draining ${receipt.draining.join(',')}`)
  check('newborn ⇒ released (nothing to bring back)', receipt.released.join(',') === 'concourse-w3' && rec('concourse-w3')?.endedAt !== undefined, `fix parkAllConcourseSessions in src/daemon/concourse-workers/concourseWorkers.ts so a newborn runner is released and its row ended; released ${receipt.released.join(',')}`)
  check("stopped ⇒ untouched (the operator's own state)", receipt.skipped.join(',') === 'concourse-w4' && rec('concourse-w4')?.stoppedAt !== undefined && rec('concourse-w4')?.parkedAt === undefined, `fix parkAllConcourseSessions in src/daemon/concourse-workers/concourseWorkers.ts so an operator-stopped row is left untouched; skipped ${receipt.skipped.join(',')}`)
  check('the drain set names the mid-turn runners', sup.pendingParkRequests(dir).sort().join(',') === 'concourse-w2,concourse-w5', `fix pendingParkRequests in src/daemon/concourse-workers/concourseWorkers.ts to list the runners with a standing park request; got ${sup.pendingParkRequests(dir).sort().join(',')}`)
  sup.updateConcourseWorkers(ws => { ws['concourse-w2']!.lastTurnSettledAt = now }, dir)
  const retiring = retiringRunners(sup, dir, DEAD_PID)
  retiring.seat('concourse-w2')
  check("the runner's own turn-settled edge completes the park: the runner retires by its own leave (asked, never killed), parked, the request cleared", !sup.completeRequestedPark('concourse-w2', roster, dir) && (await sup.retireRequestedPark('concourse-w2', retiring.roster, dir, { exitWaitMs: 2_000 })) && retiring.askedOf('concourse-w2') === 'prepare,commit' && !killed.includes('concourse-w2') && retiring.killed.length === 0 && rec('concourse-w2')?.parkedAt !== undefined && rec('concourse-w2')?.parkRequestedAt === undefined, 'fix completeRequestedPark and retireRequestedPark in src/daemon/concourse-workers/concourseWorkers.ts so a settled turn retires the runner by its own leave, parks the row and clears the request')
  retiring.close()
  check('the drain set shrinks to the one still working', sup.pendingParkRequests(dir).join(',') === 'concourse-w5', `fix pendingParkRequests in src/daemon/concourse-workers/concourseWorkers.ts to drop a request once the runner is parked; got ${sup.pendingParkRequests(dir).join(',')}`)
  const cut = sup.parkConcourseSession(sid('5'), 'daemon:owner-orphaned', roster, dir, { afterTurn: false, reason: sup.PARK_DRAIN_CUT_REASON })
  check('a request still standing at the ceiling is cut: parked now, the row says so', cut.outcome === 'applied' && killed.includes('concourse-w5') && rec('concourse-w5')?.parkReason === 'parked — turn cut at the drain ceiling' && sup.pendingParkRequests(dir).length === 0, `fix parkConcourseSession and PARK_DRAIN_CUT_REASON in src/daemon/concourse-workers/concourseWorkers.ts so a cut park kills the runner and writes the cut reason; outcome ${cut.outcome}`)
  sup.updateConcourseWorkers(ws => { for (const w of Object.values(ws)) if (w.endedAt === undefined) w.pid = DEAD_PID }, dir)
  const reconcile = sup.reconcileConcourseWorkers(new Set(), dir)
  const onBoard = Object.values(sup.readSessionWorkers(dir)).filter(r => r.endedAt === undefined)
  check('the next boot finds every closed chat PARKED — no crash rows, nothing released', reconcile.settled.length === 0 && reconcile.parked.sort().join(',') === 'concourse-w1,concourse-w2,concourse-w5' && onBoard.every(r => r.crash === undefined), `fix reconcileConcourseWorkers in src/daemon/concourse-workers/concourseWorkers.ts so a parked row is reported parked and given no crash row; ${JSON.stringify(reconcile)}`)
  check("the stopped row keeps the operator's stop; the newborn stays released", rec('concourse-w4')?.stoppedAt !== undefined && rec('concourse-w3')?.endedAt !== undefined, 'fix reconcileConcourseWorkers in src/daemon/concourse-workers/concourseWorkers.ts so it keeps the stoppedAt of a stopped row and the endedAt of a released one')
  seed([{ runnerId: 'concourse-w9', sessionId: sid('9'), pid: DEAD_PID, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 }])
  const hard = sup.reconcileConcourseWorkers(new Set(), dir)
  check("POISON CONTROL: a hard death (no park written) still paints the crash row — the crash-row law stands", hard.settled.includes('concourse-w9') && rec('concourse-w9')?.crash !== undefined && rec('concourse-w9')?.parkedAt === undefined, 'fix reconcileConcourseWorkers in src/daemon/concourse-workers/concourseWorkers.ts so a dead pid with no park written settles as a crash row')
}

console.log('Q2 the drain ceiling knob')
{
  check('the default is 10 minutes', idle.sessionParkDrainMs() === 10 * 60_000, `fix sessionParkDrainMs in src/daemon/control/idleRetirement.ts so the default ceiling is 10 minutes; got ${idle.sessionParkDrainMs()}`)
  process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '3'
  check('the knob reads minutes', idle.sessionParkDrainMs() === 3 * 60_000, `fix sessionParkDrainMs in src/daemon/control/idleRetirement.ts to read MERCURY_SESSION_PARK_DRAIN_MINUTES as minutes; got ${idle.sessionParkDrainMs()}`)
  process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '0'
  check('0 ⇒ no wait', idle.sessionParkDrainMs() === 0, `fix sessionParkDrainMs in src/daemon/control/idleRetirement.ts so MERCURY_SESSION_PARK_DRAIN_MINUTES=0 means no wait; got ${idle.sessionParkDrainMs()}`)
  delete process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES
  const knob = getFlagSpec('MERCURY_SESSION_PARK_DRAIN_MINUTES')
  check('the knob is a registered row naming its consumer and the cut wording', knob !== undefined && knob.consumer.includes('sessionParkDrainMs') && knob.summary.includes("'parked — turn cut at the drain ceiling'"), 'fix the MERCURY_SESSION_PARK_DRAIN_MINUTES row in the flag registry (FLAG_REGISTRY) so its consumer names sessionParkDrainMs and its summary quotes the cut wording')
  check('the cut reason has ONE owner', sup.PARK_DRAIN_CUT_REASON === 'parked — turn cut at the drain ceiling', 'PARK_DRAIN_CUT_REASON in src/daemon/concourse-workers/concourseWorkers.ts must keep this wording; change the flag row summary and this check together if you rename it')
}


console.log('Q6 a refused chat-forward birth lands the face directly')
{
  handover.markExplicitBootJourney()
  check('an explicit journey is marked', handover.bootJourneyIsExplicit(), 'fix markExplicitBootJourney and bootJourneyIsExplicit in src/platform/substrate/splashHandover.ts')
  handover.retractExplicitBootJourney()
  check('the retraction clears it (the resolver lands the Boot face)', !handover.bootJourneyIsExplicit(), 'fix retractExplicitBootJourney in src/platform/substrate/splashHandover.ts so it clears the explicit-journey mark')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-close-all: ALL LAWS HOLD' : `\nprove-close-all: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
