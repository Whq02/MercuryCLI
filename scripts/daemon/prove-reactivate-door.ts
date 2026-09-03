#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-reactivate-door.ts — REACTIVATE IS THE ONE DOOR (law 2
//  of the reactivation lifecycle), driven on the
//  REAL policy (makeConcourseAdmitHandler + warmRunner.ts) over a scratch
//  home with a scripted roster; no daemon, no child.
//
//   R1  THE WARM ROAD: a resume of a PARKED record whose workspace holds a
//       warm runner CLAIMS it with `resume: true` — the record moves onto
//       the claimed short in ONE publication (parked → live: pid re-pointed,
//       the park cleared, title and birth time kept), the old short frees,
//       the respawn argv flips to --resume <id>, the pool re-warms; the ack
//       time prints for the receipt (the felt-Enter class of a birth);
//   R2  THE COLD ROAD: no warm runner ⇒ the SAME record respawns on its own
//       short with --resume <id> (never a second record);
//   R3  A LIVE standing record is entered, nothing spawns or claims; a park
//       requested mid-turn is withdrawn (the operator came back);
//   R4  A REFUSED reactivate leaves the row PARKED with the daemon's own
//       sentence on it — a crashed record refused (the roster cannot
//       spawn) becomes parked-with-reason, never a ghost, never a crash;
//       a held checkout refuses typed and the row says so;
//   R5  NEVER TWO STATES: after every road exactly one un-ended record owns
//       the session;
//   R6  THE RUNNER SIDE (source): the warm claim's `resume` loads the
//       transcript through the cold boot's own loader BEFORE the ack,
//       refuses an empty one and hands the home pin back, splices the live
//       conversation, hydrates the run; the wire names the field;
//   R7  THE SCREEN DOOR (source): focusResumedSession reads the standing
//       record (workspace, home, title from the record — never the screen's
//       cwd), and says the focus verb again through the connector once the
//       record stands (assertSeat guards on the slot).
//
//  POISONS: drop the standing-record arm from the admit handler ⇒ R1/R2
//  mint a SECOND record (R5 fails: two states); drop `resume: true` from
//  the claim ⇒ R1's frame pin fails (a claimed runner with no history);
//  drop refuseReactivate's stamp ⇒ R4 (a refused crash row stays a crash);
//  drop assertSeat ⇒ R7 (a record-less resume never stamps focus).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'reactivate-door-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
// The registry default resolves only over SIGNED-IN families; this prover's
// estate is the reactivate door, so the fixture key stands in (presence,
// never validity — the probe-key idiom).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-reactivate-door-probe'
delete process.env.MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_DAEMON_NO_SELF_WARM
delete process.env.MERCURY_CONCOURSE_WORKER

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const warm = await import('../../src/daemon/warmRunner.ts')
const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

/** The pool's roster port, scripted (prove-warm-runner's shape): the claim
 *  ack replays through the REAL onWarmRunnerLine waiter machinery. */
class FakeRoster {
  registered: Array<{ short: string; spec: StreamJsonChildSpec }> = []
  controls: Array<{ short: string; frame: string }> = []
  killed: string[] = []
  patched: Array<{ short: string; patch: { model: string; effort: string; respawnExtraArgv: readonly string[] } }> = []
  present = new Map<string, { alive: boolean; ready: boolean }>()
  answer: 'success' | 'error' | 'never' = 'success'
  refuseRegister = false
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  registerLongLived(short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string } {
    if (this.refuseRegister) return { ok: false, error: 'scripted spawn refusal' }
    this.registered.push({ short, spec })
    this.present.set(short, { alive: true, ready: true })
    return { ok: true, pid: process.pid }
  }
  control(short: string, frame: string): boolean {
    this.controls.push({ short, frame })
    const parsed = JSON.parse(frame) as { request_id?: string; request?: { subtype?: string } }
    if (this.answer !== 'never' && parsed.request?.subtype === 'claim_session' && typeof parsed.request_id === 'string') {
      const requestId = parsed.request_id
      const subtype = this.answer
      queueMicrotask(() =>
        warm.onWarmRunnerLine(
          JSON.stringify({
            type: 'control_response',
            response: { subtype, request_id: requestId, ...(subtype === 'error' ? { error: 'scripted refusal' } : {}) },
          }),
        ),
      )
    }
    return true
  }
  kill(short: string): boolean {
    this.killed.push(short)
    this.present.delete(short)
    return true
  }
  patchSeatClaim(short: string, patch: { model: string; effort: string; respawnExtraArgv: readonly string[] }): StreamJsonChildSpec | null {
    this.patched.push({ short, patch })
    const reg = this.registered.find(r => r.short === short)
    if (!reg) return null
    return { ...reg.spec, model: patch.model, effort: patch.effort, respawnExtraArgv: [...patch.respawnExtraArgv] }
  }
}

const dir = mkdtempSync(join(tmpdir(), 'reactivate-daemon-'))
const wsA = mkdtempSync(join(tmpdir(), 'reactivate-ws-a-'))
const wsB = mkdtempSync(join(tmpdir(), 'reactivate-ws-b-'))
const wsC = mkdtempSync(join(tmpdir(), 'reactivate-ws-c-'))
const wsD = mkdtempSync(join(tmpdir(), 'reactivate-ws-d-'))
const wsE = mkdtempSync(join(tmpdir(), 'reactivate-ws-e-'))
const roster = new FakeRoster()
const warmDeps = { roster: () => roster, dir }
const rewarmed: string[] = []
const spawned: Array<{ runnerId: string; pid: number | undefined }> = []
const admit = sup.makeConcourseAdmitHandler({
  roster: () => roster,
  dir,
  claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1_500 }, warmDeps),
  ensureWarm: workspaceDir => {
    rewarmed.push(workspaceDir)
  },
  onSpawned: (runnerId, _spec, pid) => {
    spawned.push({ runnerId, pid })
  },
})
const registryDefault = await validateWorkerModelChoice(undefined, 'session')
if (!registryDefault.ok) throw new Error(`the registry default is unavailable in this home: ${registryDefault.reason}`)
const MODEL = registryDefault.entry.modelId

const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()
const sid = (tail: string): string => `00000000-eeee-4000-8000-${tail.padStart(12, '0')}`

function seedRecord(rec: Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string; workspaceId: string }): void {
  sup.updateConcourseWorkers(workers => {
    workers[rec.runnerId] = {
      schema: 1,
      isolation: 'exclusive',
      modelKey: MODEL,
      effort: 'high',
      spawnedAt: now - 3 * T,
      lastLiveAt: now - 3 * T,
      lastDeliveryAt: now - 2 * T,
      lastTurnSettledAt: now - 2 * T + 5,
      ...rec,
    } as ConcourseWorkerRecordV1
  }, dir)
}
const recordsOf = (sessionId: string): ConcourseWorkerRecordV1[] =>
  Object.values(sup.readSessionWorkers(dir)).filter(r => r.sessionId === sessionId && r.endedAt === undefined)
const revisionOf = (): number => {
  try {
    return (JSON.parse(readFileSync(sup.concourseDeltaPath(dir), 'utf8')) as { revision: number }).revision
  } catch {
    return 0
  }
}

console.log('============================================================')
console.log(' reactivate-door — the one door on the real policy')
console.log('============================================================')

// ── R1: the warm road ───────────────────────────────────────────────────────
console.log('\n── R1: ↵ on a parked row rides the warm claim ──')
{
  const parkedSid = sid('a1')
  const wsId = sup.canonicalWorkspaceId(wsA)
  seedRecord({ runnerId: 'concourse-w1', sessionId: parkedSid, workspaceId: wsId, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test', title: 'the parked chat', spawnedAt: now - 5 * T })
  const warmed = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('R1 a warm runner stands for the workspace', warmed.state === 'warmed' && warmed.short !== undefined && warmed.short !== 'concourse-w1', JSON.stringify(warmed))
  const warmShort = warmed.short!
  const revisionBefore = revisionOf()
  const controlsBefore = roster.controls.length
  const t0 = Date.now()
  const res = await admit({ workspaceDir: wsA, resumeSessionId: parkedSid })
  const felt = Date.now() - t0
  console.log(`  (the reactivate answered in ${felt}ms on the scripted claim — the receipt records the real daemon's number at the pool)`)
  check('R1 the resume is ADMITTED on the claimed short (no cold spawn)', res.ok && res.runnerId === warmShort && res.sessionId === parkedSid, JSON.stringify(res))
  const claimFrame = roster.controls.slice(controlsBefore).map(c => JSON.parse(c.frame) as { request?: { subtype?: string; session_id?: string; resume?: boolean; model?: string } }).find(f => f.request?.subtype === 'claim_session')
  check('R1 the claim frame carries the PARKED session id and `resume: true` (the runner loads the transcript)', claimFrame?.request?.session_id === parkedSid && claimFrame?.request?.resume === true && claimFrame?.request?.model === MODEL, JSON.stringify(claimFrame))
  const standing = recordsOf(parkedSid)
  const live = standing[0]
  check('R1 ONE record owns the session, keyed by the claimed short — the old short freed', standing.length === 1 && live?.runnerId === warmShort && sup.readSessionWorkers(dir)['concourse-w1'] === undefined, JSON.stringify(standing.map(r => r.runnerId)))
  check('R1 the row flipped parked → live: pid re-pointed, the park cleared, title and birth time kept', live?.pid === process.pid && live?.parkedAt === undefined && live?.parkedBy === undefined && live?.parkReason === undefined && live?.title === 'the parked chat' && live?.spawnedAt === now - 5 * T)
  check('R1 in ONE publication (the delta stamp advanced exactly once for the flip)', revisionOf() === revisionBefore + 1, `${revisionBefore} → ${revisionOf()}`)
  check("R1 the ladder reads the record live now (never parked, never NEEDS YOU)", ['working', 'ready-to-review'].includes(snapshot.concourseRecordState(live!, { needsYou: false, alive: true })))
  check('R1 the respawn argv flipped to --resume <id> (a crash later continues the same chat)', roster.patched.some(p => p.short === warmShort && p.patch.respawnExtraArgv.join(' ').startsWith(`--resume ${parkedSid}`)))
  // BEHIND the answer by law: the handler defers the re-warm one macrotask
  // (setTimeout 0) so the reply never waits on it — yield before reading.
  await new Promise(r => setTimeout(r, 20))
  check('R1 the pool re-warms the workspace behind the answer', rewarmed.includes(wsId))
  check('R1 the seat hook fired for the claimed short', spawned.some(s => s.runnerId === warmShort))
}

// ── R2: the cold road ───────────────────────────────────────────────────────
console.log('\n── R2: no warm runner ⇒ the same record respawns with --resume ──')
{
  warm.resetWarmRunnersForTesting()
  const parkedSid = sid('b1')
  const wsId = sup.canonicalWorkspaceId(wsB)
  seedRecord({ runnerId: 'concourse-w3', sessionId: parkedSid, workspaceId: wsId, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test', title: 'cold chat', crash: { at: now - T, reason: 'crashed mid-run', respawning: false } })
  const registeredBefore = roster.registered.length
  const res = await admit({ workspaceDir: wsB, resumeSessionId: parkedSid })
  check('R2 the resume is admitted on the record\'s OWN short', res.ok && res.runnerId === 'concourse-w3', JSON.stringify(res))
  const reg = roster.registered.slice(registeredBefore).find(r => r.short === 'concourse-w3')
  const argv = [...(reg?.spec.extraArgv ?? [])]
  check('R2 the cold spawn RESUMES the same durable session (--resume <id>, never --session-id)', reg !== undefined && argv.includes('--resume') && argv.includes(parkedSid) && !argv.includes('--session-id'), JSON.stringify(argv))
  const standing = recordsOf(parkedSid)
  check('R2 one record, live: pid re-pointed, the park AND the stale crash fact cleared in the same publication', standing.length === 1 && standing[0]?.pid === process.pid && standing[0]?.parkedAt === undefined && standing[0]?.crash === undefined)
}

// ── R3: a live standing record is entered ───────────────────────────────────
console.log('\n── R3: a live record is entered — nothing spawns, nothing claims ──')
{
  const liveSid = sid('c1')
  const wsId = sup.canonicalWorkspaceId(wsC)
  seedRecord({ runnerId: 'concourse-w4', sessionId: liveSid, workspaceId: wsId, pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000, parkRequestedAt: now - 500, parkRequestedBy: 'operator:test' })
  roster.present.set('concourse-w4', { alive: true, ready: true })
  const registeredBefore = roster.registered.length
  const controlsBefore = roster.controls.length
  const res = await admit({ workspaceDir: wsC, resumeSessionId: liveSid })
  check('R3 admitted on the live record (its own identity)', res.ok && res.runnerId === 'concourse-w4' && res.pid === process.pid, JSON.stringify(res))
  check('R3 no spawn, no claim', roster.registered.length === registeredBefore && roster.controls.length === controlsBefore)
  check('R3 a park requested mid-turn is WITHDRAWN (the operator came back before the turn settled)', recordsOf(liveSid)[0]?.parkRequestedAt === undefined && recordsOf(liveSid)[0]?.parkedAt === undefined)
}

// ── R4: a refused reactivate leaves the row parked with the reason ──────────
console.log('\n── R4: refusals leave the row PARKED with the daemon\'s sentence ──')
{
  const crashedSid = sid('d1')
  const wsId = sup.canonicalWorkspaceId(wsD)
  seedRecord({ runnerId: 'concourse-w5', sessionId: crashedSid, workspaceId: wsId, pid: DEAD_PID, crash: { at: now - T, reason: 'crashed — found dead with its daemon', respawning: false }, title: 'the crashed chat' })
  roster.refuseRegister = true
  const res = await admit({ workspaceDir: wsD, resumeSessionId: crashedSid })
  roster.refuseRegister = false
  const after = recordsOf(crashedSid)[0]
  check('R4 the cold road\'s spawn refusal is typed', !res.ok && res.code === 'spawn-failed' && /scripted spawn refusal/.test(res.error), JSON.stringify(res))
  check('R4 the crashed row is now PARKED with the reason on it — never a ghost, never a crash', after?.parkedAt !== undefined && after.crash === undefined && after.endedAt === undefined && typeof after.parkReason === 'string' && /scripted spawn refusal/.test(after.parkReason), JSON.stringify(after))
  check('R4 the reason line is the row\'s cell', snapshot.concourseRecordState(after!, { needsYou: false, alive: false }) === 'parked')
  // The held checkout: a live exclusive holder in the same plain folder.
  const holderSid = sid('e1')
  const parkedSid = sid('e2')
  const wsIdE = sup.canonicalWorkspaceId(wsE)
  seedRecord({ runnerId: 'concourse-w6', sessionId: holderSid, workspaceId: wsIdE, pid: process.pid })
  roster.present.set('concourse-w6', { alive: true, ready: true })
  seedRecord({ runnerId: 'concourse-w7', sessionId: parkedSid, workspaceId: wsIdE, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test' })
  const held = await admit({ workspaceDir: wsE, resumeSessionId: parkedSid })
  const parkedAfter = recordsOf(parkedSid)[0]
  check('R4 a held checkout refuses the reactivate typed (the holder keeps the room)', !held.ok && held.code === 'workspace-collision', JSON.stringify(held))
  check('R4 the row stays parked and says why', parkedAfter?.parkedAt !== undefined && typeof parkedAfter.parkReason === 'string' && /held by a live session/.test(parkedAfter.parkReason) && parkedAfter.endedAt === undefined, JSON.stringify(parkedAfter))
  check('R4 the holder is untouched', recordsOf(holderSid)[0]?.pid === process.pid && recordsOf(holderSid)[0]?.parkedAt === undefined)
}

// ── R5: never two states ────────────────────────────────────────────────────
console.log('\n── R5: never two records for one session ──')
{
  const ids = [sid('a1'), sid('b1'), sid('c1'), sid('d1'), sid('e2')]
  check('R5 after every road exactly ONE un-ended record owns each session', ids.every(id => recordsOf(id).length === 1), ids.map(id => `${id.slice(-2)}:${recordsOf(id).length}`).join(','))
}

// ── R6: the runner side ─────────────────────────────────────────────────────
console.log('\n── R6: the warm claim loads the transcript before it acks (source) ──')
{
  const print = read('src/cli/print.ts')
  const claimAt = print.indexOf("case 'claim_session': {")
  const claimBody = print.slice(claimAt, print.indexOf("case 'set_effort': {", claimAt))
  const loadAt = claimBody.indexOf('await loadConversationForResume(sid,')
  const ackAt = claimBody.indexOf('respondSuccess(requestId, { session_id: sid })')
  check('R6 `resume: true` loads the transcript through the cold boot\'s own loader BEFORE the ack', claimBody.includes('if (request.resume === true) {') && loadAt !== -1 && ackAt !== -1 && loadAt < ackAt)
  check('R6 an empty or missing transcript refuses the claim and hands the home pin back', claimBody.includes("respondError(requestId, `claim refused — no conversation found for session ${sid}`)") && claimBody.includes('process.env.MERCURY_SESSION_HOME = claimedHome'))
  check('R6 the live conversation is the loaded one (spliced in place — the turn loop holds the same array)', claimBody.includes('messages.splice(0, messages.length, ...resumed.messages)'))
  check('R6 the same restore steps as a cold --resume boot (identity switch, file pointer, state, metadata) and the run hydration', claimBody.includes('switchSession(sid as SessionId, resumed.fullPath ? dirname(resumed.fullPath) : claimedHome)') && claimBody.includes('await resetSessionFilePointer()') && claimBody.includes('restoreSessionStateFromLog(resumed, setAppState)') && claimBody.includes('restoreSessionMetadata(resumed)') && claimBody.includes('if (request.resume === true) await hydrateResumedRun()'))
  check('R6 the boot\'s own resume road rides the same hydration closure', print.includes('if (options.continue || options.resume) await hydrateResumedRun()'))
  check('R6 the wire names the field; the pool sends it', read('src/entrypoints/sdk/controlTypes.ts').includes('resume?: boolean') && read('src/daemon/warmRunner.ts').includes("...(args.resume === true ? { resume: true } : {})"))
}

// ── R7: the screen door ─────────────────────────────────────────────────────
console.log('\n── R7: the screen door reads the record and re-says the seat (source) ──')
{
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const fnAt = hop.indexOf('async function focusResumedSessionLanding(')
  const fnBody = hop.slice(fnAt, hop.indexOf('export async function clearFocusedSession(', fnAt))
  check('R7 a live record is entered first (a hop, never a resume) — the existing pin stands', fnBody.indexOf('sessionOwnedByLiveWorker(') !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') < fnBody.indexOf("op: 'sessionAdmit'"))
  check('R7 the standing record names the workspace, home and title (never the screen\'s cwd for a record-backed row)', fnBody.includes('const standing = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)') && fnBody.includes('standing?.workspaceId ?? (await workspaceOfTranscript(transcriptPath))') && fnBody.includes('paths.getProjectDir(standing.workspaceId)'))
  // The admission's completion ADOPTS the
  // daemon's record onto the session-keyed connector and never re-points
  // the slot — the retired post-admission hop (focusDaemonSession under
  // hopIntoBoardSession) claimed a fresh epoch and yanked the bridge back
  // under a NEWER hop whenever a cold reactivate settled late. The seat is
  // re-said after the adoption, attach-gated. POISON: the old hop call.
  const adoptAt = fnBody.indexOf('const settled = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)')
  const assertAt = fnBody.indexOf('connector.assertSeat()')
  check('R7 the admission\'s completion adopts the record WITHOUT re-pointing the slot (no post-admission hop) and re-says the seat after the adoption', adoptAt !== -1 && fnBody.indexOf('seat.daemonSessionConnectorFor({', adoptAt) > adoptAt && assertAt > adoptAt && !fnBody.includes('hopIntoBoardSession(sessionId, { firstPaintMs: 0 })'))
  check('R7 the landing gate covers the slot re-point\'s tail on both doors (a transcript read slower than the ceiling never lets the caller\'s route flip refuse over an empty slot)', fnBody.includes('const pointed = seat.focusDaemonSession(connector.record)') && fnBody.includes('void withLanding(pointed.then(() => undefined)).catch(() => {})') && hop.includes('void withLanding(hop.then(() => undefined)).catch(() => {})'))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('R7 assertSeat rides the ONE chain and guards on the slot (a detached connector says nothing)', /assertSeat\(\): void \{\s*if \(this\.attached\) seatVerb\('focus', this\.record\.sessionId\)\s*\}/.test(connector))
  const supervisorSrc = read('src/daemon/concourseSupervisor.ts')
  const admitAt = supervisorSrc.indexOf('export function makeConcourseAdmitHandler(')
  const admitBody = supervisorSrc.slice(admitAt, supervisorSrc.indexOf('function mintWorktreeBranchName', admitAt))
  // The branch awaits the reactivation and answers it whole — the retained
  // model's note folded onto an admitted answer — and it sits ABOVE the
  // warm claim and the cold mint, so a standing record is never twinned.
  const reactivateAt = admitBody.indexOf('const reactivated = await reactivateConcourseSession(')
  check(
    'R7 the daemon\'s resume arm converges on the STANDING record before any mint (the two-states poison closed at the door)',
    reactivateAt !== -1 &&
      reactivateAt < admitBody.indexOf('THE WARM CLAIM (claim-over-spawn)') &&
      admitBody.indexOf('return reactivated.ok && retainedNote !== undefined ? { ...reactivated, note: retainedNote } : reactivated', reactivateAt) !== -1 &&
      admitBody.indexOf('return reactivated.ok && retainedNote !== undefined ? { ...reactivated, note: retainedNote } : reactivated', reactivateAt) < admitBody.indexOf('THE WARM CLAIM (claim-over-spawn)'),
  )
}

rmSync(SCRATCH, { recursive: true, force: true })
for (const d of [dir, wsA, wsB, wsC, wsD, wsE]) rmSync(d, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-reactivate-door: ALL LAWS HOLD' : `\nprove-reactivate-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
