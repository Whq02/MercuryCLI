#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'birth-held-records-')))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
for (const dir of [HOME, DAEMON_DIR]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT
for (const name of ['MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM', 'MERCURY_CONCOURSE_WORKER']) delete process.env[name]
writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'proof-token-not-a-real-one', refreshToken: 'proof-refresh-not-a-real-one', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)

const HINT =
  'change: the admission saves a session’s record through updateConcourseWorkersRidingOut (src/daemon/concourse-workers/store.ts) where it is born or taken back: warmSeatAnswer (admitWarm.ts), coldSeatAnswer (admitCold.ts), the claimed branch of reactivateConcourseSession (reactivate.ts) and the revive it falls back to (revive.ts), so a records file another process holds for a moment is waited for and only a file held past the whole wait answers that no session was started'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, HINT].filter(Boolean).join(' | ')}`}`)
}

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')
const publish = await import('../../src/platform/substrate/durablePublish.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
type StandInRunner = ReturnType<typeof standInRunner>
type RunnerDoor = import('../../src/daemon/runner-link/runnerConnection.ts').RunnerDoor
type Spec = ReturnType<typeof sup.buildConcourseWorkerSpec>

class FakeRoster {
  registered: string[] = []
  killed: string[] = []
  stands = new Map<string, StandInRunner>()
  present = new Set<string>()
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const here = this.present.has(short)
    return { present: here, alive: here, ready: here }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present].map(short => ({ short }))
  }
  registerLongLived(short: string): { ok: boolean; pid?: number; error?: string } {
    this.registered.push(short)
    this.present.add(short)
    this.stands.set(short, standInRunner({ sessionId: null, autoAnswer: { 'session/claim': (params: unknown) => ({ session_id: String((params as { session_id: unknown }).session_id) }) } }))
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
  patchSeatClaim(short: string, patch: { model: string; effort: string; respawnExtraArgv: readonly string[] }): Spec | null {
    return this.registered.includes(short) ? sup.buildConcourseWorkerSpec({ runnerId: short, workspaceId: SCRATCH, modelKey: patch.model, effort: patch.effort, kind: 'oculus', kit: { schema: 1, mcp: [], skills: [], invocable: [] } }) : null
  }
}

function refuseTheSave(forMs: number | null): void {
  process.env.MERCURY_FAULT_INJECT = 'rename@concourse-workers.json:eperm'
  publish._resetFaultInjectionCountersForTests()
  if (forMs !== null) setTimeout(letTheSaveThrough, forMs)
}
function letTheSaveThrough(): void {
  delete process.env.MERCURY_FAULT_INJECT
}
const saveRefused = (): boolean => process.env.MERCURY_FAULT_INJECT !== undefined

const roster = new FakeRoster()
const warmDeps = { roster: () => roster, dir: DAEMON_DIR }
const admit = sup.makeConcourseAdmitHandler({
  roster: () => roster,
  dir: DAEMON_DIR,
  claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1_500 }, warmDeps),
  ensureWarm: (): void => {},
})
const workspace = (name: string): string => sup.canonicalWorkspaceId(mkdtempSync(join(SCRATCH, `${name}-`)))
const recordOf = (sessionId: string): ConcourseWorkerRecordV1 | undefined => Object.values(sup.readSessionWorkers(DAEMON_DIR)).find(rec => rec.sessionId === sessionId && rec.endedAt === undefined)
function parkedSession(tail: string, ws: string): string {
  const sessionId = `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`
  const runnerId = `concourse-parked-${tail}`
  const now = Date.now()
  sup.updateConcourseWorkers(workers => {
    const record: ConcourseWorkerRecordV1 = { schema: 1, runnerId, sessionId, workspaceId: ws, isolation: 'exclusive', modelKey: 'claude-sonnet-5', effort: 'high', spawnedAt: now - 60_000, lastLiveAt: now - 30_000, parkedAt: now - 20_000, parkedBy: 'operator' }
    workers[runnerId] = record
  }, DAEMON_DIR)
  mkdirSync(getProjectDir(ws), { recursive: true })
  writeFileSync(join(getProjectDir(ws), `${sessionId}.jsonl`), '')
  return sessionId
}

type Birth = { answer: Awaited<ReturnType<typeof admit>>; tookMs: number; killedNow: string[] }
async function born(req: Parameters<typeof admit>[0], heldForMs: number | null): Promise<Birth> {
  const killedBefore = roster.killed.length
  refuseTheSave(heldForMs)
  const started = Date.now()
  try {
    const answer = await admit({ by: 'operator', ...req })
    return { answer, tookMs: Date.now() - started, killedNow: roster.killed.slice(killedBefore) }
  } finally {
    letTheSaveThrough()
  }
}
function rodeOut(name: string, birth: Birth, sessionId: string | undefined, runnerId: string | undefined): void {
  check(`${name} the session is started, not refused`, birth.answer.ok === true, `${JSON.stringify(birth.answer).slice(0, 300)} after ${birth.tookMs} ms`)
  check(`${name} its runner was not ended`, birth.killedNow.length === 0 && runnerId !== undefined && roster.has(runnerId).alive, `ended ${JSON.stringify(birth.killedNow)}`)
  const record = sessionId === undefined ? undefined : recordOf(sessionId)
  check(`${name} the records on disk name the session on its runner, not parked`, record !== undefined && record.runnerId === runnerId && record.parkedAt === undefined && record.pid === process.pid, JSON.stringify(record))
  check(`${name} the admission waited for the holder to let go and no longer than its patience`, birth.tookMs >= 1_400 && birth.tookMs < 4_500 && !saveRefused(), `answered after ${birth.tookMs} ms`)
}

console.log('============================================================')
console.log(' a new or resumed session rides out a records file another process holds for a moment')
console.log('============================================================')
try {
  console.log('\n(a) a new session on the standing warm runner, the save of its record refused for 1.5 s, then free')
  {
    const ws = workspace('a')
    const stood = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
    const birth = await born({ workspaceDir: ws }, 1_500)
    rodeOut('(a)', birth, birth.answer.ok ? birth.answer.sessionId : undefined, stood.short)
  }

  console.log('\n(b) a new session on a runner spawned for it (no warm runner stands), the save refused for 1.5 s, then free')
  {
    const ws = workspace('b')
    const birth = await born({ workspaceDir: ws }, 1_500)
    rodeOut('(b)', birth, birth.answer.ok ? birth.answer.sessionId : undefined, birth.answer.ok ? birth.answer.runnerId : undefined)
  }

  console.log('\n(c) a parked session taken back by the standing warm runner, the save refused for 1.5 s, then free')
  {
    const ws = workspace('c')
    const sessionId = parkedSession('c', ws)
    const stood = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
    const birth = await born({ workspaceDir: ws, resumeSessionId: sessionId }, 1_500)
    rodeOut('(c)', birth, sessionId, stood.short)
  }

  console.log('\n(d) a parked session taken back by a runner spawned for it, the save refused for 1.5 s, then free')
  {
    const ws = workspace('d')
    const sessionId = parkedSession('d', ws)
    const birth = await born({ workspaceDir: ws, resumeSessionId: sessionId }, 1_500)
    rodeOut('(d)', birth, sessionId, 'concourse-parked-d')
  }

  console.log('\n(e) the save refused for ever: the daemon says so as it did, after its whole patience')
  {
    const ws = workspace('e')
    const stood = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
    const birth = await born({ workspaceDir: ws }, null)
    check('(e) no session is started and the answer is the daemon’s own sentence', birth.answer.ok === false && birth.answer.code === 'not-ready' && birth.answer.error.startsWith('no session was started: '), JSON.stringify(birth.answer).slice(0, 300))
    check('(e) the runner that was claimed for it is ended and no record names it', stood.short !== undefined && birth.killedNow.includes(stood.short) && sup.readSessionWorkers(DAEMON_DIR)[stood.short] === undefined, `ended ${JSON.stringify(birth.killedNow)}`)
    check('(e) it waited about three seconds before it gave up', birth.tookMs >= 2_800 && birth.tookMs < 6_000, `answered after ${birth.tookMs} ms`)
  }
} finally {
  letTheSaveThrough()
  for (const stand of roster.stands.values()) stand.close()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-birth-rides-out-held-records' : `\nFAIL prove-birth-rides-out-held-records (${failures})`)
process.exit(failures === 0 ? 0 : 1)
