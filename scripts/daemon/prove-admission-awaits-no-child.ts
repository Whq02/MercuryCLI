#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'admission-no-child-home-'))
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
writeFileSync(
  join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: '[redacted]', refreshToken: '[redacted]', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
for (const name of ['MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM']) delete process.env[name]

const watch = { ...(await import('../../src/daemon/control/ownerWatch.ts')) }
type Ask = { pid: number; settled: boolean }
const asks: Ask[] = []
let read: (pid: number) => Promise<string | null> = pid => watch.getProcessStartInstantAsync(pid)
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({
  ...watch,
  getProcessStartInstantAsync: (pid: number): Promise<string | null> => {
    const ask: Ask = { pid, settled: false }
    asks.push(ask)
    return read(pid).finally(() => {
      ask.settled = true
    })
  },
}))

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const { makeConcourseAdmitHandler, readSessionWorkers, updateConcourseWorkers, reactivateConcourseSession, buildConcourseWorkerSpec, canonicalWorkspaceId } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
type StandInRunner = ReturnType<typeof standInRunner>
type RunnerDoor = import('../../src/daemon/runner-link/runnerConnection.ts').RunnerDoor
type Spec = ReturnType<typeof buildConcourseWorkerSpec>

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, 'change: the warm runner’s start instant is asked where it is spawned (ensureWarmRunner, src/daemon/runner-link/warmRunner.ts) and carried by the claim to the admit road (src/daemon/concourse-workers/admit.ts, reactivate.ts), which asks again only when that read gave nothing'].filter(Boolean).join(' | ')}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function settled(): Promise<void> {
  const stop = Date.now() + 10_000
  while (asks.some(ask => !ask.settled) && Date.now() < stop) await sleep(5)
}

class FakeRoster {
  registered: Array<{ short: string; spec: Spec }> = []
  stands = new Map<string, StandInRunner>()
  present = new Set<string>()
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const here = this.present.has(short)
    return { present: here, alive: here, ready: here }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present].map(short => ({ short }))
  }
  registerLongLived(short: string, spec: Spec): { ok: boolean; pid?: number; error?: string } {
    this.registered.push({ short, spec })
    this.present.add(short)
    this.stands.set(short, standInRunner({ sessionId: null, autoAnswer: { 'session/claim': (params: unknown) => ({ session_id: String((params as { session_id: unknown }).session_id) }) } }))
    return { ok: true, pid: process.pid }
  }
  door(short: string): RunnerDoor | undefined {
    const stand = this.stands.get(short)
    return stand === undefined || stand.connection.closed ? undefined : stand.connection
  }
  kill(short: string): boolean {
    this.present.delete(short)
    this.stands.get(short)?.close('killed')
    this.stands.delete(short)
    return true
  }
  patchSeatClaim(short: string, patch: { model: string; effort: string; respawnExtraArgv: readonly string[] }): Spec | null {
    const reg = this.registered.find(row => row.short === short)
    return reg === undefined ? null : { ...reg.spec, model: patch.model, effort: patch.effort, respawnExtraArgv: [...patch.respawnExtraArgv] }
  }
}

const recordsDir = mkdtempSync(join(tmpdir(), 'admission-no-child-daemon-'))
const workspace = (name: string): string => canonicalWorkspaceId(mkdtempSync(join(tmpdir(), `admission-no-child-${name}-`)))
const roster = new FakeRoster()
const warmDeps = { roster: () => roster, dir: recordsDir }
const admitDeps = {
  roster: () => roster,
  dir: recordsDir,
  claimWarm: (args: Parameters<typeof warm.claimWarmRunner>[0]) => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1_500 }, warmDeps),
  ensureWarm: (): void => {},
}
const admitDoor = makeConcourseAdmitHandler(admitDeps)
const live = await watch.getProcessStartInstantAsync(process.pid)

console.log('============================================================')
console.log(' an admission that claims a warm runner waits for no process read: the start instant was asked at the spawn')
console.log('============================================================')

console.log('\n── A: the read made at the spawn serves the admission ──')
{
  const ws = workspace('a')
  const ensured = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
  check('A the warm runner stands', ensured.state === 'warmed', ensured.detail ?? '')
  await settled()
  check('A its start instant was asked once, where it was spawned', asks.length === 1 && asks[0]!.pid === process.pid, `${asks.length} read(s) before any admission`)
  const before = asks.length
  const admitted = await admitDoor({ by: 'operator', workspaceDir: ws })
  const during = asks.length - before
  check('A the admission claimed the warm runner', admitted.ok === true && admitted.runnerId === ensured.short, JSON.stringify(admitted).slice(0, 300))
  check('A the admission asked the system for no start instant of its own', during === 0, `${during} read(s) between the claim and the answer`)
  const record = admitted.ok ? readSessionWorkers(recordsDir)[admitted.runnerId] : undefined
  check('A the session record names the pid and the start instant the system gives for it', record?.pid === process.pid && typeof live === 'string' && live !== '' && record.procStart === live, `pid ${record?.pid} procStart ${JSON.stringify(record?.procStart)} against ${JSON.stringify(live)}`)
}

for (const [name, nothing] of [['B', null], ['C', '']] as const) {
  console.log(`\n── ${name}: the read at the spawn gave ${nothing === null ? 'no answer' : 'no such process'}, so the admission reads once more ──`)
  const ws = workspace(name.toLowerCase())
  read = () => Promise.resolve(nothing)
  const ensured = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
  await settled()
  read = pid => watch.getProcessStartInstantAsync(pid)
  const before = asks.length
  const admitted = await admitDoor({ by: 'operator', workspaceDir: ws })
  const during = asks.length - before
  check(`${name} the admission claimed the warm runner`, ensured.state === 'warmed' && admitted.ok === true && admitted.runnerId === ensured.short, JSON.stringify(admitted).slice(0, 300))
  check(`${name} the admission read the start instant itself, once`, during === 1, `${during} read(s) between the claim and the answer`)
  const record = admitted.ok ? readSessionWorkers(recordsDir)[admitted.runnerId] : undefined
  check(`${name} the session record still names the pid and its start instant`, record?.pid === process.pid && typeof live === 'string' && live !== '' && record.procStart === live, `pid ${record?.pid} procStart ${JSON.stringify(record?.procStart)} against ${JSON.stringify(live)}`)
}

console.log('\n── D: a parked session taken back by a warm runner waits for no process read either ──')
{
  const ws = workspace('d')
  const sessionId = '44444444-4444-4444-8444-444444444444'
  updateConcourseWorkers(workers => {
    workers['concourse-parked'] = { runnerId: 'concourse-parked', sessionId, workspaceId: ws, modelKey: 'claude-opus-5', effort: 'high', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now() - 30_000, parkedAt: Date.now() - 20_000, parkedBy: 'operator' } as never
  }, recordsDir)
  const ensured = await warm.ensureWarmRunner({ workspaceDir: ws }, warmDeps)
  await settled()
  const before = asks.length
  const taken = await reactivateConcourseSession(readSessionWorkers(recordsDir)['concourse-parked']!, { modelKey: 'claude-opus-5', by: 'operator', kind: 'oculus' }, [], admitDeps)
  const during = asks.length - before
  check('D the warm runner took the parked session back', ensured.state === 'warmed' && taken.ok === true && taken.runnerId === ensured.short, JSON.stringify(taken).slice(0, 300))
  check('D taking it back asked the system for no start instant of its own', during === 0, `${during} read(s) between the claim and the answer`)
  const record = taken.ok ? readSessionWorkers(recordsDir)[taken.runnerId] : undefined
  check('D the session record names the pid and the start instant the system gives for it', record?.pid === process.pid && typeof live === 'string' && live !== '' && record.procStart === live, `pid ${record?.pid} procStart ${JSON.stringify(record?.procStart)} against ${JSON.stringify(live)}`)
}

console.log(failures === 0 ? '\nprove-admission-awaits-no-child: all green' : `\nprove-admission-awaits-no-child: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
