#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'reactivate-door-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-reactivate-door-probe'
delete process.env.MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_DAEMON_NO_SELF_WARM
delete process.env.MERCURY_CONCOURSE_WORKER

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')
const { LEAVE_PENDING, standInRunner } = await import('../lib/seatDoor.ts')
const { RpcError, RPC_REFUSED } = await import('../../src/daemon/runner-wire/errors.ts')
type StandInRunner = ReturnType<typeof standInRunner>
type RunnerDoor = import('../../src/daemon/runner-link/runnerConnection.ts').RunnerDoor
const { validateWorkerModelChoice } = await import('../../src/screen/concourse-model/workerModels.ts')
const snapshot = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import type { RunnerChildSpec } from '../../src/daemon/runner-link/headlessRun.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond && !label.startsWith('R6')) console.log('      fix: the reactivate road is makeConcourseAdmitHandler in src/daemon/concourse-workers/concourseWorkers.ts (the warm claim is claimWarmRunner in src/daemon/runner-link/warmRunner.ts); change it until the law in the label holds')
}

class FakeRoster {
  registered: Array<{ short: string; spec: RunnerChildSpec }> = []
  stands = new Map<string, StandInRunner>()
  claims: Array<{ short: string; params: Record<string, unknown> }> = []
  killed: string[] = []
  patched: Array<{ short: string; patch: { model: string; effort: string; respawnExtraArgv: readonly string[] } }> = []
  present = new Map<string, { alive: boolean; ready: boolean }>()
  answer: 'success' | 'error' | 'never' = 'success'
  refuseRegister = false
  firstLines = new Map<string, () => void>()
  afterFirstLine(short: string, listener: () => void): () => void {
    this.firstLines.set(short, listener)
    return () => {
      this.firstLines.delete(short)
    }
  }
  deliverFirstLine(short: string): void {
    const listener = this.firstLines.get(short)
    this.firstLines.delete(short)
    listener?.()
  }
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  registerLongLived(short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string } {
    if (this.refuseRegister) return { ok: false, error: 'scripted spawn refusal' }
    this.registered.push({ short, spec })
    this.present.set(short, { alive: true, ready: true })
    const stand = standInRunner({
      sessionId: null,
      autoAnswer: {
        'session/claim': (params: unknown) => {
          const claim = params as Record<string, unknown>
          this.claims.push({ short, params: claim })
          if (this.answer === 'never') return LEAVE_PENDING
          if (this.answer === 'error') throw new RpcError(RPC_REFUSED, 'scripted refusal', { kind: 'claim' })
          return { session_id: String(claim.session_id) }
        },
      },
    })
    this.stands.set(short, stand)
    return { ok: true, pid: process.pid }
  }
  door(short: string): RunnerDoor | undefined {
    const stand = this.stands.get(short)
    return stand === undefined || stand.connection.closed ? undefined : stand.connection
  }
  kill(short: string): boolean {
    this.killed.push(short)
    this.present.delete(short)
    this.stands.get(short)?.close('killed')
    this.stands.delete(short)
    return true
  }
  patchSeatClaim(short: string, patch: { model: string; effort: string; respawnExtraArgv: readonly string[] }): RunnerChildSpec | null {
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
const admitDoor = sup.makeConcourseAdmitHandler({
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
const admit: typeof admitDoor = req => admitDoor({ by: 'operator', ...req })
const registryDefault = await validateWorkerModelChoice(undefined, 'session')
if (!registryDefault.ok) throw new Error(`the registry default is unavailable in this home: ${registryDefault.reason}`)
const MODEL = registryDefault.entry.modelId

const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()
const sid = (tail: string): string => `00000000-eeee-4000-8000-${tail.padStart(12, '0')}`

function seedRecord(rec: Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string; workspaceId: string }): void {
  const transcript = sup.concourseTranscriptPath(rec)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: `${rec.sessionId}-u1`, sessionId: rec.sessionId, message: { role: 'user', content: 'seeded turn' } })}\n`)
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

console.log('\n── R1: ↵ on a parked row rides the warm claim ──')
{
  const parkedSid = sid('a1')
  const wsId = sup.canonicalWorkspaceId(wsA)
  seedRecord({ runnerId: 'concourse-w1', sessionId: parkedSid, workspaceId: wsId, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test', title: 'the parked chat', spawnedAt: now - 5 * T })
  const warmed = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('R1 a warm runner stands for the workspace', warmed.state === 'warmed' && warmed.short !== undefined && warmed.short !== 'concourse-w1', JSON.stringify(warmed))
  const warmShort = warmed.short!
  const revisionBefore = revisionOf()
  const claimsBefore = roster.claims.length
  const t0 = Date.now()
  const res = await admit({ workspaceDir: wsA, resumeSessionId: parkedSid })
  const felt = Date.now() - t0
  console.log(`  (the reactivate answered in ${felt}ms on the scripted claim — the receipt records the real daemon's number at the pool)`)
  check('R1 the resume is ADMITTED on the claimed short (no cold spawn)', res.ok && res.runnerId === warmShort && res.sessionId === parkedSid, JSON.stringify(res) + ' — an enter on a parked row must claim the warm runner, not spawn cold')
  const claim = roster.claims.slice(claimsBefore)[0]?.params
  check('R1 the session/claim request carries the PARKED session id and `resume: true` (the runner loads the transcript)', claim?.session_id === parkedSid && claim?.resume === true && claim?.model === MODEL, JSON.stringify(claim) + ' — the claim params sent to the warm runner must carry session_id, resume true and the model')
  const standing = recordsOf(parkedSid)
  const live = standing[0]
  check('R1 ONE record owns the session, keyed by the claimed short — the old short freed', standing.length === 1 && live?.runnerId === warmShort && sup.readSessionWorkers(dir)['concourse-w1'] === undefined, JSON.stringify(standing.map(r => r.runnerId)))
  check('R1 the row flipped parked → live: pid re-pointed, the park cleared, title and birth time kept', live?.pid === process.pid && live?.parkedAt === undefined && live?.parkedBy === undefined && live?.parkReason === undefined && live?.title === 'the parked chat' && live?.spawnedAt === now - 5 * T)
  check('R1 in ONE publication (the delta stamp advanced exactly once for the flip)', revisionOf() === revisionBefore + 1, `${revisionBefore} → ${revisionOf()} — the flip must publish the concourse delta once, not twice or not at all`)
  check("R1 the ladder reads the record live now (never parked, never NEEDS YOU)", ['working', 'ready-to-review'].includes(workers.concourseRecordState(live!, { needsYou: false, alive: true })))
  check('R1 the respawn argv flipped to --resume <id> (a crash later continues the same chat)', roster.patched.some(p => p.short === warmShort && p.patch.respawnExtraArgv.join(' ').startsWith(`--resume ${parkedSid}`)))
  roster.deliverFirstLine(warmShort)
  await new Promise(r => setTimeout(r, 20))
  check('R1 the pool re-warms the workspace behind the answer', rewarmed.includes(wsId))
  check('R1 the seat hook fired for the claimed short', spawned.some(s => s.runnerId === warmShort))
}

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
  check('R2 the cold spawn RESUMES the same durable session (--resume <id>, never --session-id)', reg !== undefined && argv.includes('--resume') && argv.includes(parkedSid) && !argv.includes('--session-id'), JSON.stringify(argv) + ' — the cold respawn spec must pass --resume with the parked session id')
  const standing = recordsOf(parkedSid)
  check('R2 one record, live: pid re-pointed, the park AND the stale crash fact cleared in the same publication', standing.length === 1 && standing[0]?.pid === process.pid && standing[0]?.parkedAt === undefined && standing[0]?.crash === undefined)
}

console.log('\n── R3: a live record is entered — nothing spawns, nothing claims ──')
{
  const liveSid = sid('c1')
  const wsId = sup.canonicalWorkspaceId(wsC)
  seedRecord({ runnerId: 'concourse-w4', sessionId: liveSid, workspaceId: wsId, pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000, parkRequestedAt: now - 500, parkRequestedBy: 'operator:test' })
  roster.present.set('concourse-w4', { alive: true, ready: true })
  const registeredBefore = roster.registered.length
  const claimsBefore = roster.claims.length
  const res = await admit({ workspaceDir: wsC, resumeSessionId: liveSid })
  check('R3 admitted on the live record (its own identity)', res.ok && res.runnerId === 'concourse-w4' && res.pid === process.pid, JSON.stringify(res))
  check('R3 no spawn, no claim', roster.registered.length === registeredBefore && roster.claims.length === claimsBefore)
  check('R3 a park requested mid-turn is WITHDRAWN (the operator came back before the turn settled)', recordsOf(liveSid)[0]?.parkRequestedAt === undefined && recordsOf(liveSid)[0]?.parkedAt === undefined)
}

console.log('\n── R4: refusals leave the row PARKED with the daemon\'s sentence ──')
{
  const crashedSid = sid('d1')
  const wsId = sup.canonicalWorkspaceId(wsD)
  seedRecord({ runnerId: 'concourse-w5', sessionId: crashedSid, workspaceId: wsId, pid: DEAD_PID, crash: { at: now - T, reason: 'crashed — ended unexpectedly', respawning: false }, title: 'the crashed chat' })
  roster.refuseRegister = true
  const res = await admit({ workspaceDir: wsD, resumeSessionId: crashedSid })
  roster.refuseRegister = false
  const after = recordsOf(crashedSid)[0]
  check('R4 the cold road\'s spawn refusal is typed', !res.ok && res.code === 'spawn-failed' && /scripted spawn refusal/.test(res.error), JSON.stringify(res) + ' — a refused spawn must answer ok false with code spawn-failed and the spawn error text')
  check('R4 the crashed row is now PARKED with the reason on it — never a ghost, never a crash', after?.parkedAt !== undefined && after.crash === undefined && after.endedAt === undefined && typeof after.parkReason === 'string' && /scripted spawn refusal/.test(after.parkReason), JSON.stringify(after))
  check('R4 the reason line is the row\'s cell', workers.concourseRecordState(after!, { needsYou: false, alive: false }) === 'parked')
  const lostSid = sid('d2')
  seedRecord({ runnerId: 'concourse-w8', sessionId: lostSid, workspaceId: wsId, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test', title: 'the lost chat' })
  rmSync(sup.concourseTranscriptPath({ sessionId: lostSid, workspaceId: wsId }), { force: true })
  const registeredBeforeLost = roster.registered.length
  const lost = await admit({ workspaceDir: wsD, resumeSessionId: lostSid })
  const lostAfter = recordsOf(lostSid)[0]
  check('R4 a parked row whose transcript is gone is refused BEFORE any spawn (nothing to resume it around)', !lost.ok && /transcript is gone/.test(lost.error) && roster.registered.length === registeredBeforeLost, JSON.stringify(lost) + ' — a parked row with no transcript must be refused with the words transcript is gone before any spawn')
  check('R4 …and stays parked with the loss as its reason, never a ghost, never live', lostAfter?.parkedAt !== undefined && lostAfter.pid === DEAD_PID && /transcript is gone/.test(lostAfter.parkReason ?? '') && workers.concourseRecordState(lostAfter, { needsYou: false, alive: false }) === 'parked', JSON.stringify(lostAfter))
  const holderSid = sid('e1')
  const parkedSid = sid('e2')
  const wsIdE = sup.canonicalWorkspaceId(wsE)
  seedRecord({ runnerId: 'concourse-w6', sessionId: holderSid, workspaceId: wsIdE, pid: process.pid })
  roster.present.set('concourse-w6', { alive: true, ready: true })
  seedRecord({ runnerId: 'concourse-w7', sessionId: parkedSid, workspaceId: wsIdE, pid: DEAD_PID, parkedAt: now - T, parkedBy: 'operator:test' })
  const held = await admit({ workspaceDir: wsE, resumeSessionId: parkedSid })
  const parkedAfter = recordsOf(parkedSid)[0]
  check('R4 a held checkout refuses the reactivate typed (the holder keeps the room)', !held.ok && held.code === 'workspace-collision', JSON.stringify(held) + ' — a checkout held by a live session must refuse the reactivate with code workspace-collision')
  check('R4 the row stays parked and says why', parkedAfter?.parkedAt !== undefined && typeof parkedAfter.parkReason === 'string' && /held by a live session/.test(parkedAfter.parkReason) && parkedAfter.endedAt === undefined, JSON.stringify(parkedAfter))
  check('R4 the holder is untouched', recordsOf(holderSid)[0]?.pid === process.pid && recordsOf(holderSid)[0]?.parkedAt === undefined)
}

console.log('\n── R5: never two records for one session ──')
{
  const ids = [sid('a1'), sid('b1'), sid('c1'), sid('d1'), sid('e2')]
  check('R5 after every road exactly ONE un-ended record owns each session', ids.every(id => recordsOf(id).length === 1), ids.map(id => `${id.slice(-2)}:${recordsOf(id).length}`).join(','))
}

console.log('\n── R6: the warm claim binds and acks, then loads the transcript behind the answer (source) ──')
{
  const { refusalOf, withLiveRunner } = await import('../lib/builtProduct.ts')
  const UNSEEN = '11111111-2222-4333-8444-555555555555'
  const CLAIMED = '66666666-7777-4888-8999-000000000000'
  const pinnedHome = mkdtempSync(join(tmpdir(), 'reactivate-home-pin-'))
  const refusedClaim = await withLiveRunner(
    async runner => ({
      resume: await refusalOf(runner.request('session/claim', { session_id: UNSEEN, resume: true })),
      fresh: await refusalOf(runner.request('session/claim', { session_id: CLAIMED })),
      pinned: readdirSync(pinnedHome),
    }),
    { env: { MERCURY_CONCOURSE_WORKER: '1', MERCURY_SESSION_HOME: pinnedHome } },
  ).catch(() => null)
  rmSync(pinnedHome, { recursive: true, force: true })
  check('R6 a missing transcript refuses the claim before it binds and hands the home pin back', refusedClaim?.resume?.message === `claim refused — no conversation found for session ${UNSEEN}` && refusedClaim.fresh === null && refusedClaim.pinned.some(name => name.startsWith(`${CLAIMED}.jsonl`)), JSON.stringify(refusedClaim) + ' — the runner session/claim handler (not the daemon) must refuse a resume claim with no transcript and still bind a fresh claim; a null value means the live runner did not start, so build dist first')
}


rmSync(SCRATCH, { recursive: true, force: true })
for (const d of [dir, wsA, wsB, wsC, wsD, wsE]) rmSync(d, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-reactivate-door: ALL LAWS HOLD' : `\nprove-reactivate-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
